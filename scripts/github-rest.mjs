import { execFileSync } from 'node:child_process';

// Builds a `gh api` caller. Errors carry the HTTP status when gh reports one
// and never expose stderr in the message.
export function createGhApi(execFile = execFileSync) {
  return function ghApi(args, { input } = {}) {
    try {
      return execFile('gh', ['api', ...args], {
        encoding: 'utf8',
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        ...(input === undefined ? {} : { input }),
      });
    } catch (cause) {
      const error = new Error('GitHub request failed', { cause });
      const match = /HTTP (\d{3})/.exec(String(cause?.stderr ?? ''));
      if (match) error.httpStatus = Number(match[1]);
      throw error;
    }
  };
}

export const ghApi = createGhApi();
