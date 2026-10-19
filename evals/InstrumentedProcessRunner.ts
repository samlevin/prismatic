// A process runner that never starts a process. It records every request
// and answers from a scripted responder, so a security test can inspect
// exactly what a reviewer asked to run.

export interface ProcessOptions {
  readonly shell?: boolean | string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  // Text written to the process's standard input, such as the object names
  // `git cat-file --batch` reads.
  readonly input?: string;
}

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ProcessOptions;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessResponder = (
  request: ProcessRequest,
) => ProcessResult | Promise<ProcessResult>;

const succeed: ProcessResponder = () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
});

export class InstrumentedProcessRunner {
  readonly #responder: ProcessResponder;
  readonly #requests: ProcessRequest[] = [];

  constructor(responder: ProcessResponder = succeed) {
    this.#responder = responder;
  }

  get requests(): readonly ProcessRequest[] {
    return [...this.#requests];
  }

  async run(
    command: string,
    args: readonly string[] = [],
    options: ProcessOptions = {},
  ): Promise<ProcessResult> {
    // Copies, so a caller that mutates its arrays afterwards cannot change
    // the record.
    const request: ProcessRequest = Object.freeze({
      command,
      args: Object.freeze([...args]),
      options: Object.freeze({
        ...options,
        ...(options.env === undefined
          ? {}
          : { env: Object.freeze({ ...options.env }) }),
      }),
    });
    this.#requests.push(request);
    return this.#responder(request);
  }
}
