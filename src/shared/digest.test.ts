import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.ts';
import { sha256 } from './digest.ts';

describe('sha256', () => {
  it('matches the published test vectors', () => {
    expect(sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes a string as its UTF-8 bytes', () => {
    expect(sha256('é')).toBe(sha256(new Uint8Array([0xc3, 0xa9])));
  });

  it('gives equal digests for equal values in canonical form', () => {
    expect(sha256(canonicalJson({ a: 1, b: 2 }))).toBe(
      sha256(canonicalJson({ b: 2, a: 1 })),
    );
  });

  it('refuses a string UTF-8 cannot encode exactly', () => {
    expect(() => sha256('\uD800')).toThrow(TypeError);
  });
});
