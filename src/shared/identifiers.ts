// Commit identifiers. A Sha is a full lowercase hexadecimal object name: 40
// digits in a SHA-1 repository, 64 in a SHA-256 one. Abbreviated, uppercase,
// and padded forms are refused rather than expanded or folded, so equal
// commits always compare equal as strings.
import { ValidationError } from './validation.ts';

export type Sha = string & { readonly __brand: 'Sha' };

const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isSha(input: unknown): input is Sha {
  return typeof input === 'string' && shaPattern.test(input);
}

export function parseSha(input: unknown): Sha {
  if (!isSha(input)) {
    throw new ValidationError(
      'invalid-sha',
      'Expected a full lowercase hexadecimal commit SHA of 40 or 64 digits.',
    );
  }
  return input;
}
