// Content digests. sha256 identifies content; it is not authentication, since
// anyone can compute it. Use a keyed MAC where a value must prove its origin.
import { createHash } from 'node:crypto';

// Lowercase hexadecimal SHA-256 of the bytes, or of a string's UTF-8 encoding.
// A string with an unpaired surrogate is refused: UTF-8 would replace it with
// U+FFFD, and two different strings would share a digest.
export function sha256(bytes: Uint8Array | string): string {
  if (typeof bytes === 'string' && !bytes.isWellFormed()) {
    throw new TypeError(
      'sha256 cannot encode a string with an unpaired surrogate.',
    );
  }
  return createHash('sha256').update(bytes).digest('hex');
}
