import { chmodSync, closeSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Internal I/O counters; public card counts continue to count emitted cards. */
export interface ProjectionWrites {
  written: number;
  skipped: number;
  bytesWritten: number;
}

/** Compare exact bytes, then atomically replace changed projections. Read and
 * permission errors remain errors. Existing symlink destinations/modes survive. */
export function writeProjection(path: string, text: string, stats?: ProjectionWrites): void {
  const bytes = Buffer.from(text);
  let target = path;
  let mode: number | undefined;
  try {
    const previous = readFileSync(path);
    if (previous.equals(bytes)) {
      if (stats) stats.skipped++;
      return;
    }
    target = realpathSync(path);
    mode = statSync(target).mode;
    // Rename must not bypass a destination's existing write protection.
    closeSync(openSync(target, "r+"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode });
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
    if (stats) { stats.written++; stats.bytesWritten += bytes.length; }
  } finally {
    rmSync(temporary, { force: true });
  }
}
