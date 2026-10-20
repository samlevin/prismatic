// Production code builds the runner from its home and redactor only.
import {
  type ProcessLimits,
  ReadOnlyProcessRunner,
} from '../../src/repository/ReadOnlyProcessRunner.ts';
import { patternSecretRedactor } from '../../src/shared/redaction.ts';

export function startRunner(home: string): ReadOnlyProcessRunner {
  return new ReadOnlyProcessRunner({ home, redactor: patternSecretRedactor });
}

export const limits: ProcessLimits = {
  cwd: '/tmp/work',
  timeoutMs: 1000,
  maxStdoutBytes: 1024,
  maxStderrBytes: 1024,
};
