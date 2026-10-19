// Adversarial inputs for the scoped-fetch spike (#141): names and tree
// entries a malicious PR can commit, as they arrive from `git ls-tree -z` and
// `git diff --raw -z`, and the admission, probe and pattern rules that must
// keep them out of a fetch, patch, search or index. The fixture corpus in
// #139 will supply these from generated repositories; until then the cases
// are listed here.
import { describe, expect, it } from 'vitest';
import { planAdmission } from '../../experiments/fetch/lib/admission.ts';
import type { Candidate } from '../../experiments/fetch/lib/admission.ts';
import { GitRunner } from '../../experiments/fetch/lib/gitCommand.ts';
import {
  parseLsTree,
  parseRawDiff,
} from '../../experiments/fetch/lib/inventory.ts';
import { probeContent } from '../../experiments/fetch/lib/probe.ts';
import { nodeSpawner } from '../../experiments/fetch/lib/processRunner.ts';
import type { ProcessResult } from '../../experiments/fetch/lib/processRunner.ts';
import {
  literalPathspec,
  sparsePatternFor,
} from '../../experiments/fetch/lib/sparsePattern.ts';
import { patternSecretRedactor } from '../../src/shared/redaction.ts';
import { credentialExamples } from '../support/credentials.ts';

const blob = 'b'.repeat(40);
const oldBlob = 'a'.repeat(40);
const char = (codePoint: number): string => String.fromCodePoint(codePoint);

function lsTreeRecord(name: Buffer | string, mode = '100644'): Buffer {
  return Buffer.concat([
    Buffer.from(`${mode} blob ${blob}\t`),
    typeof name === 'string' ? Buffer.from(name) : name,
    Buffer.from([0]),
  ]);
}

function rawRecord(name: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from(`:100644 100644 ${oldBlob} ${blob} M\0`),
    typeof name === 'string' ? Buffer.from(name) : name,
    Buffer.from([0]),
  ]);
}

const hostileNames: readonly (string | Buffer)[] = [
  '../../../../etc/passwd',
  'src/../../outside.ts',
  '.git/config',
  '.git/hooks/post-checkout.ts',
  'sub/.GIT/config',
  'GIT~1/config.ts',
  'src\\..\\..\\secret.ts',
  'src/\nINJECTED log line.ts',
  'src/\rcarriage.ts',
  `src/innocent${char(0x202e)}st.ts`,
  `src/zero${char(0x200b)}width${char(0x200d)}.ts`,
  'src//double.ts',
  'src/./dot.ts',
  Buffer.from([0x73, 0x72, 0x63, 0x2f, 0xc0, 0xaf, 0x2e, 0x74, 0x73]),
  Buffer.from([0x73, 0x2f, 0xed, 0xa0, 0x80, 0x2e, 0x74, 0x73]),
];

describe('hostile names in tree and diff metadata', () => {
  it.each(hostileNames.map((name) => [name]))(
    'never lets %j reach admission',
    (name) => {
      const listing = parseLsTree(lsTreeRecord(name));
      const diff = parseRawDiff(rawRecord(name));
      expect(listing.entries).toEqual([]);
      expect(diff.changes).toEqual([]);
      expect(listing.rejected).toHaveLength(1);
      expect(diff.rejected).toHaveLength(1);
    },
  );

  it('records a rejected name without echoing it as text', () => {
    const name = 'src/\n::error::forged annotation.ts';
    const [rejected] = parseRawDiff(rawRecord(name)).rejected;
    expect(JSON.stringify(rejected)).not.toContain('forged');
    expect(rejected?.byteLength).toBe(Buffer.byteLength(name));
  });

  it('keeps shell metacharacters as data, escaped in patterns and literal in pathspecs', () => {
    const name = 'src/$(rm -rf ~); `id` | tee >out & echo *?[x].ts';
    const [entry] = parseLsTree(lsTreeRecord(name)).entries;
    expect(entry?.path).toBe(name);
    const pattern = sparsePatternFor(name);
    expect(pattern).toEqual({
      ok: true,
      pattern: '/src/$(rm -rf ~); `id` | tee >out & echo \\*\\?\\[x\\].ts',
    });
    expect(literalPathspec(name)).toBe(`:(literal)${name}`);
  });

  it('refuses a name that would span two sparse-pattern lines', () => {
    expect(sparsePatternFor('src/a.ts\n/**').ok).toBe(false);
  });

  it('passes a hostile name to the child as one argument, never through a shell', async () => {
    const name = 'src/$(touch /tmp/pwned).ts; echo pwned';
    const result = await nodeSpawner(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
        name,
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 20_000,
        maxOutputBytes: 4096,
      },
    );
    expect(JSON.parse(result.stdout.toString())).toEqual([name]);
  });
});

describe('tree entries that must never be acquired', () => {
  const candidate = (overrides: Partial<Candidate>): Candidate => ({
    path: 'src/a.ts',
    revision: 'head',
    mode: '100644',
    oid: blob,
    advertisedSize: 100,
    ...overrides,
  });

  it.each([
    [
      'a symlink to a secret',
      { mode: '120000', path: 'src/key.ts' },
      'symlink',
    ],
    ['a submodule', { mode: '160000', path: 'vendor/lib' }, 'submodule'],
    ['a Git config attempt', { path: '.gitattributes' }, 'extension'],
    ['a workflow', { path: '.github/workflows/ci.yml' }, 'extension'],
    ['a lockfile', { path: 'package-lock.json' }, 'extension'],
    ['vendored code', { path: 'vendor/lib/a.ts' }, 'prohibited-directory'],
    ['an oversized file', { advertisedSize: 300 * 1024 }, 'oversized'],
    ['a file of unknown size', { advertisedSize: undefined }, 'unknown-size'],
    [
      'a file the PR hides with .gitignore',
      { path: 'src/hidden.ts' },
      'ignored',
    ],
  ] as const)('excludes %s from metadata', (_label, overrides, reason) => {
    const plan = planAdmission(
      [candidate(overrides)],
      new Set(['src/hidden.ts']),
    );
    expect(plan.oids).toEqual([]);
    expect(plan.excluded[0]?.reason).toBe(reason);
  });

  it('rejects an LFS pointer and a binary disguised as source after acquisition', () => {
    const pointer = Buffer.from(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'c'.repeat(64)}\nsize 999999999\n`,
    );
    const disguised = Buffer.concat([
      Buffer.from('export const a = 1;\n'),
      Buffer.from([0, 1, 2, 3]),
    ]);
    expect(probeContent(pointer).contentClass).toBe('lfs-pointer');
    expect(probeContent(disguised).contentClass).toBe('binary');
  });
});

describe('Git process output', () => {
  it('redacts a credential Git echoes on stderr', async () => {
    const secret = credentialExamples['github-token'] ?? '';
    expect(secret).not.toBe('');
    const reply: ProcessResult = {
      status: 128,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: `fatal: could not read from https://x-access-token:${secret}@github.com/o/r.git`,
      elapsedMs: 1,
      truncated: false,
      timedOut: false,
    };
    const runner = new GitRunner({
      gitPath: '/usr/local/bin/git',
      home: '/tmp/home',
      spawner: () => Promise.resolve(reply),
      allowFileProtocol: false,
      redactText: (text) => patternSecretRedactor.redactText(text),
    });
    const result = await runner.run('/repo', ['fetch', 'origin']);
    expect(result.stderr).not.toContain(secret);
    const error = await runner
      .ok('/repo', ['fetch'])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
  });
});
