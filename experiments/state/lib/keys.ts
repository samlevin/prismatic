// The §7.4 keys. Each is a SHA-256 over the canonical JSON array of its parts
// rather than the parts joined with `|`, so no part can contain a separator
// that makes two different inputs collide.
import { canonicalJson } from '../../../src/shared/canonical.ts';
import { sha256 } from '../../../src/shared/digest.ts';

export interface ReviewKeyInput {
  readonly repoId: number;
  readonly prNumber: number;
  readonly baseRepoId: number;
  readonly baseRefName: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly configDigest: string;
  readonly reviewerVersion: string;
}

export function reviewKey(input: ReviewKeyInput): string {
  return sha256(
    canonicalJson([
      'review',
      input.repoId,
      input.prNumber,
      input.baseRepoId,
      input.baseRefName,
      input.mergeBaseSha,
      input.headSha,
      input.configDigest,
      input.reviewerVersion,
    ]),
  );
}

// An automatic attempt is deterministic, so a rerun of the same event finds
// the same attempt. An authorized manual attempt adds the immutable command
// comment id or dispatch run id, which is what makes it new.
export function attemptId(
  review: string,
  manual?: { readonly kind: 'command' | 'dispatch'; readonly id: number },
): string {
  return sha256(
    canonicalJson(
      manual === undefined
        ? ['attempt', review, 'automatic']
        : ['attempt', review, manual.kind, manual.id],
    ),
  );
}

// Excludes the review mode, so a replay in another mode publishes nothing
// twice.
export function roundKey(review: string, attempt: string): string {
  return sha256(canonicalJson(['round', review, attempt]));
}

export function effectId(round: string, kind: string, ordinal: number): string {
  return sha256(canonicalJson(['effect', round, kind, ordinal]));
}
