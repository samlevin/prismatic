// Runs the current Node binary as the child process, so the tests need no
// other tool and no network.
import { describe, expect, it } from 'vitest';
import { nodeSpawner } from './processRunner.ts';
import type { SpawnOptions } from './processRunner.ts';

const node = process.execPath;
const options = (overrides: Partial<SpawnOptions> = {}): SpawnOptions => ({
  cwd: process.cwd(),
  env: { PATH: '/usr/bin:/bin' },
  timeoutMs: 20_000,
  maxOutputBytes: 1024 * 1024,
  ...overrides,
});

describe('nodeSpawner', () => {
  it('captures stdout, stderr and the exit status', async () => {
    const result = await nodeSpawner(
      node,
      [
        '-e',
        'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)',
      ],
      options(),
    );
    expect(result.status).toBe(3);
    expect(result.stdout.toString()).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeGreaterThan(0);
  });

  it('passes arguments without a shell', async () => {
    const hostile = '$(echo pwned); `id` | cat > /tmp/x & echo';
    const result = await nodeSpawner(
      node,
      ['-e', 'process.stdout.write(process.argv[1])', hostile],
      options(),
    );
    expect(result.stdout.toString()).toBe(hostile);
  });

  it('gives the child only the environment it was handed', async () => {
    const result = await nodeSpawner(
      node,
      [
        '-e',
        'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))',
      ],
      options({ env: { ONLY: '1' } }),
    );
    // macOS adds __CF_USER_TEXT_ENCODING to every process; nothing from the
    // parent's environment may appear.
    const keys = JSON.parse(result.stdout.toString()) as string[];
    expect(keys).toContain('ONLY');
    expect(keys.filter((key) => key !== '__CF_USER_TEXT_ENCODING')).toEqual([
      'ONLY',
    ]);
  });

  it('writes string, buffer and streamed input', async () => {
    const echo = ['-e', 'process.stdin.pipe(process.stdout)'];
    const fromString = await nodeSpawner(node, echo, options({ input: 'abc' }));
    expect(fromString.stdout.toString()).toBe('abc');
    const fromBuffer = await nodeSpawner(
      node,
      echo,
      options({ input: Buffer.from('def') }),
    );
    expect(fromBuffer.stdout.toString()).toBe('def');
    async function* chunks() {
      for (let index = 0; index < 64; index += 1)
        yield Buffer.alloc(64 * 1024, 97 + (index % 26));
    }
    const streamed = await nodeSpawner(
      node,
      echo,
      options({ input: chunks(), maxOutputBytes: 8 * 1024 * 1024 }),
    );
    expect(streamed.stdout.length).toBe(64 * 64 * 1024);
    expect(streamed.stdout[64 * 1024]).toBe(98);
  });

  it('closes stdin when there is no input', async () => {
    const result = await nodeSpawner(
      node,
      [
        '-e',
        'let n = 0; process.stdin.on("data", (c) => (n += c.length)); process.stdin.on("end", () => process.stdout.write(String(n)))',
      ],
      options(),
    );
    expect(result.stdout.toString()).toBe('0');
  });

  it('kills a child whose output exceeds the cap', async () => {
    const result = await nodeSpawner(
      node,
      ['-e', 'setInterval(() => process.stdout.write("x".repeat(4096)), 1)'],
      options({ maxOutputBytes: 10_000 }),
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(10_000);
    expect(result.signal).toBe('SIGKILL');
  });

  it('kills a child whose stderr exceeds the cap', async () => {
    const result = await nodeSpawner(
      node,
      ['-e', 'setInterval(() => process.stderr.write("y".repeat(4096)), 1)'],
      options({ maxOutputBytes: 5_000 }),
    );
    expect(result.truncated).toBe(true);
    expect(result.stderr.length).toBe(5_000);
  });

  it('kills a child that passes its deadline', async () => {
    const result = await nodeSpawner(
      node,
      ['-e', 'setInterval(() => {}, 1000)'],
      options({ timeoutMs: 200 }),
    );
    expect(result.timedOut).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('survives a child that exits before reading its input', async () => {
    async function* endless() {
      for (;;) yield Buffer.alloc(1024 * 1024);
    }
    const result = await nodeSpawner(
      node,
      ['-e', 'process.exit(0)'],
      options({ input: endless() }),
    );
    expect(result.status === 0 || result.signal === 'SIGKILL').toBe(true);
  });

  it('rejects when the executable cannot start', async () => {
    await expect(
      nodeSpawner('/nonexistent/prismatic-spike-binary', [], options()),
    ).rejects.toThrow();
  });
});
