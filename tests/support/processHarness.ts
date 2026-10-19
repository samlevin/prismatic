// The test-only hook into ReadOnlyProcessRunner. Tests run outside the Action
// image, where the pinned binaries are not at their image paths, and fixture
// remotes are local `file://` repositories, which the normative Git options
// refuse. The harness spawner maps each approved binary to a local one and,
// when asked, adds `-c protocol.file.allow=always` to git runs after the
// normative options. Production code cannot import anything outside src/ and
// apps/ (the import-boundary lint rule) and the build never compiles this
// directory, so production never reaches this switch.
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import {
  type ApprovedBinary,
  approvedBinaryPaths,
  nodeProcessSpawner,
  normativeGitArguments,
  type ProcessSpawner,
  ReadOnlyProcessRunner,
} from '../../src/repository/ReadOnlyProcessRunner.ts';
import {
  patternSecretRedactor,
  type SecretRedactor,
} from '../../src/shared/redaction.ts';

export const fileProtocolConfig = 'protocol.file.allow=always';

export interface HarnessOptions {
  // Local executables to run in place of the image paths. A binary that is
  // missing here is looked up on PATH.
  readonly binaries?: Partial<Record<ApprovedBinary, string>>;
  // Adds `-c protocol.file.allow=always` to every git run.
  readonly allowFileProtocol?: boolean;
  // The spawner that starts the mapped process.
  readonly spawner?: ProcessSpawner;
}

// The executable `name` resolves to on PATH, or undefined.
export function findOnPath(
  name: string,
  searchPath = process.env.PATH ?? '',
): string | undefined {
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === '') continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

export function harnessSpawner(options: HarnessOptions = {}): ProcessSpawner {
  const spawner = options.spawner ?? nodeProcessSpawner;
  const local = new Map<string, ApprovedBinary>(
    Object.entries(approvedBinaryPaths).map(([binary, file]) => [
      file,
      binary as ApprovedBinary,
    ]),
  );
  return async (request) => {
    const binary = local.get(request.file);
    if (binary === undefined)
      throw new Error(`The harness does not map ${request.file}.`);
    const file = options.binaries?.[binary] ?? findOnPath(binary);
    if (file === undefined)
      throw new Error(`No local ${binary} was found for the harness.`);
    let args = request.args;
    if (binary === 'git' && options.allowFileProtocol === true) {
      const prefix = args.slice(0, normativeGitArguments.length);
      if (prefix.join('\0') !== normativeGitArguments.join('\0'))
        throw new Error(
          'The git run does not start with the normative options.',
        );
      args = [
        ...prefix,
        '-c',
        fileProtocolConfig,
        ...args.slice(normativeGitArguments.length),
      ];
    }
    return spawner({ ...request, file, args });
  };
}

export function harnessProcessRunner(
  options: HarnessOptions & {
    readonly home: string;
    readonly redactor?: SecretRedactor;
  },
): ReadOnlyProcessRunner {
  return new ReadOnlyProcessRunner({
    home: options.home,
    redactor: options.redactor ?? patternSecretRedactor,
    spawner: harnessSpawner(options),
  });
}
