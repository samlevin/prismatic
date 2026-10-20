// The bounded content probe from §5.1. Tree metadata cannot tell a binary
// file or a Git LFS pointer from source, so after an admitted blob arrives
// its first bytes are classified, and anything but text is rejected before
// it reaches a patch, search, index or prompt. LFS targets are never
// fetched; the pointer is the whole blob.

// Git's own binary heuristic looks for a NUL byte in the first 8000 bytes.
export const probeByteLimit = 8000;

// The Git LFS specification caps a pointer file at 1024 bytes.
export const lfsPointerMaxBytes = 1024;

const lfsPrefix = Buffer.from('version https://git-lfs.github.com/spec/v1\n');
const lfsOidLine = /^oid sha256:[0-9a-f]{64}$/m;
const lfsSizeLine = /^size \d+$/m;

export type ContentClass = 'text' | 'binary' | 'lfs-pointer';

export interface ProbeResult {
  readonly contentClass: ContentClass;
  // Bytes the probe examined, which count against the read budget.
  readonly probedBytes: number;
}

export function probeContent(blob: Buffer): ProbeResult {
  const head = blob.subarray(0, probeByteLimit);
  if (
    blob.length <= lfsPointerMaxBytes &&
    head.subarray(0, lfsPrefix.length).equals(lfsPrefix)
  ) {
    const text = head.toString('latin1');
    if (lfsOidLine.test(text) && lfsSizeLine.test(text))
      return { contentClass: 'lfs-pointer', probedBytes: head.length };
  }
  return {
    contentClass: head.includes(0) ? 'binary' : 'text',
    probedBytes: head.length,
  };
}
