// Starts a child process without a shell, with an explicit environment, a
// deadline, and a cap on captured output. Input can be a buffer or a stream
// of chunks, so the 2 GiB fixture can be written into `git fast-import`
// without holding it in memory.
import { spawn } from 'node:child_process';

export type SpawnInput = string | Buffer | AsyncIterable<Buffer>;

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly input?: SpawnInput;
}

export interface ProcessResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly elapsedMs: number;
  // True when stdout or stderr went over maxOutputBytes, or the deadline
  // passed. The process is killed in both cases.
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export type Spawner = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<ProcessResult>;

class Capture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  overflowed = false;
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  add(chunk: Buffer): boolean {
    if (this.overflowed) return false;
    const room = this.#limit - this.#bytes;
    if (chunk.length > room) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#bytes = this.#limit;
      this.overflowed = true;
      return false;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    return true;
  }

  value(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

async function writeInput(
  stdin: NodeJS.WritableStream,
  input: SpawnInput | undefined,
): Promise<void> {
  if (input === undefined) {
    stdin.end();
    return;
  }
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    stdin.end(input);
    return;
  }
  for await (const chunk of input) {
    if (!stdin.write(chunk))
      await new Promise<void>((resolve) => stdin.once('drain', resolve));
  }
  stdin.end();
}

export const nodeSpawner: Spawner = (file, args, options) =>
  new Promise<ProcessResult>((resolve, reject) => {
    const started = performance.now();
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = new Capture(options.maxOutputBytes);
    const stderr = new Capture(options.maxOutputBytes);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (!stdout.add(chunk)) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (!stderr.add(chunk)) child.kill('SIGKILL');
    });
    // A child that exits before reading all of its input closes the pipe;
    // its exit status, not the write error, is the result.
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout: stdout.value(),
        stderr: stderr.value().toString('utf8'),
        elapsedMs: performance.now() - started,
        truncated: stdout.overflowed || stderr.overflowed || timedOut,
        timedOut,
      });
    });
    writeInput(child.stdin, options.input).catch(() => child.kill('SIGKILL'));
  });
