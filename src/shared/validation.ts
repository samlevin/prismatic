// The error the shared primitives throw for input they refuse. The message
// names the rule that failed and never echoes the rejected input, which may be
// untrusted, oversized, or secret.

export type ValidationCode =
  | 'invalid-sha'
  | 'invalid-path'
  | 'path-normalization-collision'
  | 'content-too-large'
  | 'binary-content'
  | 'invalid-utf8'
  | 'control-heavy-content'
  | 'unknown-severity';

export class ValidationError extends Error {
  readonly code: ValidationCode;

  constructor(code: ValidationCode, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}
