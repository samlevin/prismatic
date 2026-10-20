// Parser for `git cat-file --batch` output: a `<oid> blob <size>` header,
// the content, and a newline per object. Any other header, including
// `<oid> missing`, is an error, because the spike reads only blobs it has
// acquired.
export function parseCatFileBatch(output: Buffer): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  while (offset < output.length) {
    const newline = output.indexOf(10, offset);
    const header = output.subarray(offset, newline).toString('latin1');
    const match = /^([0-9a-f]{40}) blob (\d+)$/.exec(header);
    if (match === null)
      throw new Error(`Unexpected cat-file header: ${header}`);
    const size = Number(match[2]);
    blobs.set(
      match[1] as string,
      output.subarray(newline + 1, newline + 1 + size),
    );
    offset = newline + 1 + size + 1;
  }
  return blobs;
}
