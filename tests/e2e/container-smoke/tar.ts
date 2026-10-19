// Lists the entries of a tar stream, such as the one `docker cp <container>:
// <path> -` writes, with the numeric owner the archive recorded for each.
export interface TarEntry {
  readonly path: string;
  readonly type: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

const blockSize = 512;

function text(bytes: Uint8Array): string {
  const value = Buffer.from(bytes).toString('utf8');
  const end = value.indexOf('\0');
  return (end < 0 ? value : value.slice(0, end)).trim();
}

function octal(bytes: Uint8Array): number {
  const value = text(bytes);
  return value === '' ? 0 : Number.parseInt(value, 8);
}

// The `path` record of a PAX extended header, if it has one.
function paxPath(body: Uint8Array): string | undefined {
  for (const record of Buffer.from(body).toString('utf8').split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

export function listTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingPath: string | undefined;
  while (offset + blockSize <= archive.length) {
    const header = archive.subarray(offset, offset + blockSize);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = text(header.subarray(156, 157)) || '0';
    const body = archive.subarray(
      offset + blockSize,
      offset + blockSize + size,
    );
    offset += blockSize + Math.ceil(size / blockSize) * blockSize;
    if (type === 'x') {
      pendingPath = paxPath(body);
      continue;
    }
    if (type === 'L') {
      pendingPath = text(body);
      continue;
    }
    const prefix = text(header.subarray(345, 500));
    const name = text(header.subarray(0, 100));
    const path = pendingPath ?? (prefix === '' ? name : `${prefix}/${name}`);
    pendingPath = undefined;
    entries.push({
      path: path.replace(/\/+$/, ''),
      type,
      mode: octal(header.subarray(100, 108)),
      uid: octal(header.subarray(108, 116)),
      gid: octal(header.subarray(116, 124)),
    });
  }
  return entries;
}
