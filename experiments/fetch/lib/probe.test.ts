import { describe, expect, it } from 'vitest';
import { lfsPointerMaxBytes, probeByteLimit, probeContent } from './probe.ts';

const pointer = [
  'version https://git-lfs.github.com/spec/v1',
  `oid sha256:${'a'.repeat(64)}`,
  'size 42',
  '',
].join('\n');

describe('probeContent', () => {
  it('classifies source as text', () => {
    expect(probeContent(Buffer.from('export const a = 1;\n'))).toEqual({
      contentClass: 'text',
      probedBytes: 20,
    });
  });

  it('classifies a NUL byte inside the probe window as binary', () => {
    const blob = Buffer.alloc(100, 97);
    blob[50] = 0;
    expect(probeContent(blob).contentClass).toBe('binary');
  });

  it('reads at most the probe window', () => {
    const blob = Buffer.alloc(probeByteLimit + 500, 97);
    blob[probeByteLimit + 10] = 0;
    expect(probeContent(blob)).toEqual({
      contentClass: 'text',
      probedBytes: probeByteLimit,
    });
  });

  it('classifies a Git LFS pointer', () => {
    expect(probeContent(Buffer.from(pointer)).contentClass).toBe('lfs-pointer');
  });

  it('does not treat an oversized pointer-like file as a pointer', () => {
    const padded = Buffer.from(
      `${pointer}${'// padding\n'.repeat(lfsPointerMaxBytes)}`,
    );
    expect(probeContent(padded).contentClass).toBe('text');
  });

  it('does not treat a pointer prefix without oid and size as a pointer', () => {
    expect(
      probeContent(Buffer.from('version https://git-lfs.github.com/spec/v1\n'))
        .contentClass,
    ).toBe('text');
  });
});
