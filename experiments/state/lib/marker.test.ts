import { deflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { sha256 } from '../../../src/shared/digest.ts';
import {
  checkStructure,
  countMarkers,
  decodeMarker,
  decodePayload,
  effectMarker,
  encodeMarker,
  findEffectMarkers,
  markerLimits,
  MarkerTooLargeError,
} from './marker.ts';
import { filler } from './testing.ts';

const limits = markerLimits.state;

// A marker over arbitrary bytes, with their real digest unless one is given.
function raw(bytes: Buffer | string, digest?: string): string {
  const buffer = Buffer.from(bytes);
  const payload = deflateRawSync(buffer).toString('base64url');
  return `<!-- prra:state:v2:${payload}:${digest ?? sha256(buffer)} -->`;
}

function decodeOne(body: string): NonNullable<ReturnType<typeof decodeMarker>> {
  const decoded = decodeMarker(body, 'state');
  if (decoded === undefined) throw new Error('No marker.');
  return decoded;
}

describe('encodeMarker and decodeMarker', () => {
  test('round-trips one canonical value with one digest', () => {
    const a = encodeMarker('state', { b: [1, 'two'], a: { c: null } });
    const b = encodeMarker('state', { a: { c: null }, b: [1, 'two'] });
    expect(a).toEqual(b);
    expect(a.marker).toMatch(
      /^<!-- prra:state:v2:[A-Za-z0-9_-]+:[0-9a-f]{64} -->$/,
    );
    expect(decodeMarker(`text\n${a.marker}\nmore`, 'state')).toEqual({
      ok: true,
      value: { a: { c: null }, b: [1, 'two'] },
      digest: a.digest,
    });
    expect(decodeMarker(a.marker, 'journal')).toBeUndefined();
    const journal = encodeMarker('journal', { records: [] });
    expect(decodeMarker(journal.marker, 'journal')).toMatchObject({
      ok: true,
    });
  });

  test('refuses a body with more than one marker of a kind without decoding it', () => {
    const { marker } = encodeMarker('state', { a: 1 });
    const bomb = raw(Buffer.alloc(limits.maxDecompressedBytes * 8, 0x20));
    const body = `${marker}\n${bomb}\n${bomb}`;
    expect(countMarkers(body, 'state')).toBe(3);
    expect(countMarkers(body, 'journal')).toBe(0);
    expect(decodeMarker(body, 'state')).toEqual({
      ok: false,
      reason: 'multiple-markers',
    });
    const journal = encodeMarker('journal', { records: [] });
    expect(decodeMarker(`${marker}\n${journal.marker}`, 'state')).toEqual({
      ok: true,
      value: { a: 1 },
      digest: encodeMarker('state', { a: 1 }).digest,
    });
  });

  test('refuses older and newer versions', () => {
    const { marker } = encodeMarker('state', { a: 1 });
    for (const version of ['v1', 'v3', 'v20']) {
      expect(decodeOne(marker.replace(':v2:', `:${version}:`))).toEqual({
        ok: false,
        reason: 'unsupported-version',
      });
    }
  });

  test('checks the encoded size before decoding anything', () => {
    const payload = 'A'.repeat(limits.maxEncodedChars + 4);
    expect(decodePayload(payload, '0'.repeat(64), limits)).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  test('stops inflating a compression bomb at the decompressed cap', () => {
    const bomb = Buffer.alloc(limits.maxDecompressedBytes * 8, 0x20);
    const marker = raw(bomb);
    expect(marker.length).toBeLessThan(limits.maxEncodedChars);
    expect(decodeOne(marker)).toEqual({
      ok: false,
      reason: 'decompressed-too-large',
    });
  });

  test('reports each kind of corruption', () => {
    const digest = '0'.repeat(64);
    expect(decodePayload('A', digest, limits)).toMatchObject({
      reason: 'invalid-encoding',
    });
    expect(
      decodePayload(
        Buffer.from([0xff, 0xff, 0xff]).toString('base64url'),
        digest,
        limits,
      ),
    ).toMatchObject({ reason: 'corrupt-compression' });
    expect(decodeOne(raw('{"a":1}', digest))).toMatchObject({
      reason: 'digest-mismatch',
    });
    expect(decodeOne(raw(Buffer.from([0xc3, 0x28])))).toMatchObject({
      reason: 'invalid-utf8',
    });
    expect(decodeOne(raw('{"a":'))).toMatchObject({ reason: 'invalid-json' });
    expect(decodeOne(raw('{"b":1,"a":2}'))).toMatchObject({
      reason: 'non-canonical',
    });
    expect(decodeOne(raw('{"a": 1}'))).toMatchObject({
      reason: 'non-canonical',
    });
  });

  test('bounds nesting and array length before parsing', () => {
    const deep = `${'['.repeat(limits.maxDepth + 1)}${']'.repeat(limits.maxDepth + 1)}`;
    expect(decodeOne(raw(deep))).toMatchObject({ reason: 'too-deep' });
    const long = JSON.stringify(
      Array.from({ length: limits.maxArrayLength + 1 }, () => 0),
    );
    expect(decodeOne(raw(long))).toMatchObject({ reason: 'array-too-long' });
    const atLimit = Array.from({ length: limits.maxArrayLength }, () => 0);
    expect(decodeOne(encodeMarker('state', atLimit).marker)).toMatchObject({
      ok: true,
    });
  });

  test('refuses to write what it would refuse to read', () => {
    const deep: unknown[] = [];
    let cursor = deep;
    for (let depth = 0; depth < limits.maxDepth; depth += 1) {
      const next: unknown[] = [];
      cursor.push(next);
      cursor = next;
    }
    expect(() => encodeMarker('state', deep)).toThrow(MarkerTooLargeError);
    expect(() =>
      encodeMarker('state', 'x'.repeat(limits.maxDecompressedBytes)),
    ).toThrow('over its byte cap');
    expect(() => encodeMarker('state', filler(1, 40_000))).toThrow(
      'encoded state marker is over its cap',
    );
  });

  test('ignores a body over GitHub’s comment limit', () => {
    const { marker } = encodeMarker('state', { a: 1 });
    const long = `${marker}${' '.repeat(65_536)}`;
    expect(decodeMarker(long, 'state')).toBeUndefined();
    expect(countMarkers(long, 'state')).toBe(0);
    expect(findEffectMarkers(' '.repeat(65_537))).toEqual([]);
  });
});

describe('checkStructure', () => {
  test('skips brackets and commas inside strings', () => {
    const tight = { maxDepth: 2, maxArrayLength: 2 };
    expect(checkStructure('["[[[,,,", "\\"]]],"]', tight)).toBeUndefined();
    expect(checkStructure('{"a":1,"b":2,"c":3}', tight)).toBeUndefined();
    expect(checkStructure('[[[]]]', tight)).toBe('too-deep');
    expect(checkStructure('[1,2,3]', tight)).toBe('array-too-long');
    expect(checkStructure('[[1,2],[3,4]]', tight)).toBeUndefined();
  });
});

describe('effect markers', () => {
  test('round-trip the round key and effect id', () => {
    const roundKey = sha256('round');
    const effectId = sha256('effect');
    const body = `Inline text\n\n${effectMarker(roundKey, effectId)}`;
    expect(findEffectMarkers(body)).toEqual([{ roundKey, effectId }]);
    expect(findEffectMarkers('<!-- prra:effect:v2:abc:def -->')).toEqual([]);
  });
});
