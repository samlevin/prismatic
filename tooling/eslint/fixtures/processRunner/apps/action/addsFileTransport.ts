// Deliberate violation: production code builds a runner with its own spawner
// that turns the file transport back on, so it fails lint.
import {
  nodeProcessSpawner,
  normativeGitArguments,
  ReadOnlyProcessRunner,
} from '../../src/repository/ReadOnlyProcessRunner.ts';
import { patternSecretRedactor } from '../../src/shared/redaction.ts';

export const runner = new ReadOnlyProcessRunner({
  home: '/tmp/home',
  redactor: patternSecretRedactor,
  spawner: (request) =>
    nodeProcessSpawner({
      ...request,
      args: [
        ...normativeGitArguments,
        '-c',
        'protocol.file.allow=always',
        ...request.args.slice(normativeGitArguments.length),
      ],
    }),
});
