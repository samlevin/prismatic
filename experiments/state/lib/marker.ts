// Bounded v2 markers: `<!-- prra:<kind>:v2:<base64url(deflate-raw(json))>:<sha256> -->`.
//
// The JSON is canonical, so one value has one encoding and one digest. Every
// limit is checked before the work it guards: the encoded length before
// base64 decoding, the decompressed size by zlib's output cap while it
// inflates, and nesting depth and array lengths by a linear scan before
// JSON.parse. The digest detects corruption only. Anyone can compute it, so
// authorization comes from the comment's author id, never from the marker.
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { canonicalJson } from '../../../src/shared/canonical.ts';
import { sha256 } from '../../../src/shared/digest.ts';

export type MarkerKind = 'state' | 'journal';

export interface MarkerLimits {
  readonly maxEncodedChars: number;
  readonly maxDecompressedBytes: number;
  readonly maxDepth: number;
  readonly maxArrayLength: number;
}

// GitHub refuses a comment body over 65,536 characters.
export const maxCommentChars = 65_536;

// §7.1: the encoded snapshot is capped at 24 KiB, and a journal shard comment
// at 40,000 characters, header included.
export const markerLimits: Readonly<Record<MarkerKind, MarkerLimits>> = {
  state: {
    maxEncodedChars: 24 * 1024,
    maxDecompressedBytes: 256 * 1024,
    maxDepth: 16,
    maxArrayLength: 2_000,
  },
  journal: {
    maxEncodedChars: 39_000,
    maxDecompressedBytes: 512 * 1024,
    maxDepth: 16,
    maxArrayLength: 2_000,
  },
};

export type DecodeFailure =
  | 'unsupported-version'
  | 'too-large'
  | 'invalid-encoding'
  | 'decompressed-too-large'
  | 'corrupt-compression'
  | 'digest-mismatch'
  | 'invalid-utf8'
  | 'too-deep'
  | 'array-too-long'
  | 'invalid-json'
  | 'non-canonical';

export type Decoded =
  | { readonly ok: true; readonly value: unknown; readonly digest: string }
  | { readonly ok: false; readonly reason: DecodeFailure };

export class MarkerTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkerTooLargeError';
  }
}

export interface Encoded {
  readonly marker: string;
  readonly digest: string;
}

export function encodeMarker(
  kind: MarkerKind,
  value: unknown,
  limits: MarkerLimits = markerLimits[kind],
): Encoded {
  const text = canonicalJson(value);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > limits.maxDecompressedBytes) {
    throw new MarkerTooLargeError(`The ${kind} value is over its byte cap.`);
  }
  const structure = checkStructure(text, limits);
  if (structure !== undefined) {
    throw new MarkerTooLargeError(`The ${kind} value is ${structure}.`);
  }
  const payload = deflateRawSync(bytes, { level: 9 }).toString('base64url');
  if (payload.length > limits.maxEncodedChars) {
    throw new MarkerTooLargeError(
      `The encoded ${kind} marker is over its cap.`,
    );
  }
  const digest = sha256(bytes);
  return { marker: `<!-- prra:${kind}:v2:${payload}:${digest} -->`, digest };
}

// Every marker of this kind in a body, in order, decoded or with the reason it
// was refused. Older or newer versions are refused, never read.
export function findMarkers(
  body: string,
  kind: MarkerKind,
  limits: MarkerLimits = markerLimits[kind],
): readonly Decoded[] {
  if (body.length > maxCommentChars) return [];
  const pattern = new RegExp(
    `<!-- prra:${kind}:v([0-9]{1,4}):([A-Za-z0-9_-]*):([0-9a-f]{64}) -->`,
    'g',
  );
  // Every group is non-optional, so a match always has all three.
  return [...body.matchAll(pattern)].map((match) =>
    match[1] === '2'
      ? decodePayload(match[2] as string, match[3] as string, limits)
      : { ok: false, reason: 'unsupported-version' },
  );
}

export function decodePayload(
  payload: string,
  digest: string,
  limits: MarkerLimits,
): Decoded {
  if (payload.length > limits.maxEncodedChars) {
    return { ok: false, reason: 'too-large' };
  }
  const compressed = Buffer.from(payload, 'base64url');
  if (compressed.toString('base64url') !== payload) {
    return { ok: false, reason: 'invalid-encoding' };
  }
  let bytes: Buffer;
  try {
    bytes = inflateRawSync(compressed, {
      maxOutputLength: limits.maxDecompressedBytes,
    });
  } catch (error) {
    const tooLarge =
      error instanceof RangeError ||
      (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';
    return {
      ok: false,
      reason: tooLarge ? 'decompressed-too-large' : 'corrupt-compression',
    };
  }
  if (sha256(bytes) !== digest) return { ok: false, reason: 'digest-mismatch' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'invalid-utf8' };
  }
  const structure = checkStructure(text, limits);
  if (structure !== undefined) return { ok: false, reason: structure };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (canonicalJson(value) !== text) {
    return { ok: false, reason: 'non-canonical' };
  }
  return { ok: true, value, digest };
}

// One pass over JSON text, outside strings, counting container depth and the
// commas of each open array.
export function checkStructure(
  text: string,
  limits: Pick<MarkerLimits, 'maxDepth' | 'maxArrayLength'>,
): 'too-deep' | 'array-too-long' | undefined {
  const commas: (number | undefined)[] = [];
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[' || char === '{') {
      commas.push(char === '[' ? 0 : undefined);
      if (commas.length > limits.maxDepth) return 'too-deep';
    } else if (char === ']' || char === '}') commas.pop();
    else if (char === ',') {
      const top = commas.length - 1;
      const count = commas[top];
      if (count === undefined) continue;
      commas[top] = count + 1;
      if (count + 2 > limits.maxArrayLength) return 'array-too-long';
    }
  }
  return undefined;
}

// Effect markers carry no payload: the round key and effect id are enough to
// tell, by reading, whether a write that timed out happened.
export function effectMarker(roundKey: string, effectId: string): string {
  return `<!-- prra:effect:v2:${roundKey}:${effectId} -->`;
}

export function findEffectMarkers(
  body: string,
): readonly { readonly roundKey: string; readonly effectId: string }[] {
  if (body.length > maxCommentChars) return [];
  return [
    ...body.matchAll(/<!-- prra:effect:v2:([0-9a-f]{64}):([0-9a-f]{64}) -->/g),
  ].map((match) => ({
    roundKey: match[1] as string,
    effectId: match[2] as string,
  }));
}
