import { readFileSync, openSync, readSync, closeSync } from "node:fs";

function decodeSource(bytes: Buffer): string | null {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  return bytes.toString("utf8");
}

/** Read source text, decoding Windows tooling's common UTF-16LE output. UTF-16BE
 * is rare and unsupported by Node's built-in decoders, so callers silently skip it. */
export function readSourceFile(path: string): string | null {
  return decodeSource(readFileSync(path));
}

/** Classification must not read arbitrary whole files to inspect a shebang. */
export function readSourcePrefix(path: string, maxBytes: number): string | null {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(maxBytes);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    return decodeSource(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}
