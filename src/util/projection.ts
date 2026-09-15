import { chmodSync, closeSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/** Internal I/O counters; public card counts continue to count emitted cards. */
export interface ProjectionWrites {
  written: number;
  skipped: number;
  bytesWritten: number;
}

/** realpath cannot resolve a missing leaf. Follow any dangling leaf symlinks
 * until we reach the intended new file, preserving errors for missing parents
 * and cycles. Resolve the parent before interpreting a relative link: collapsing
 * `alias/../file` lexically would be wrong when alias itself is a symlink. */
function projectionTarget(path: string): string {
  let target = path;
  for (;;) {
    try { return realpathSync.native(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = realpathSync.native(dirname(target));
    target = join(parent, basename(target));
    if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return target;
    const link = readlinkSync(target);
    target = isAbsolute(link) ? link : `${parent}${sep}${link}`;
  }
}

/** Compare exact bytes, then atomically replace changed projections. Read and
 * permission errors remain errors. Existing symlink destinations/modes survive. */
export function writeProjection(path: string, text: string, stats?: ProjectionWrites): void {
  const bytes = Buffer.from(text);
  let mode: number | undefined;
  try {
    const previous = readFileSync(path);
    if (previous.equals(bytes)) {
      if (stats) stats.skipped++;
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const target = projectionTarget(path);
  try {
    mode = statSync(target).mode;
    // Rename must not bypass a destination's existing write protection.
    closeSync(openSync(target, "r+"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // A valid destination may already approach NAME_MAX. Keep the temporary
  // basename short and independent, while staying on the same filesystem.
  const temporary = join(dirname(target), `.graft-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode });
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
    if (stats) { stats.written++; stats.bytesWritten += bytes.length; }
  } finally {
    rmSync(temporary, { force: true });
  }
}
