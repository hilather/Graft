/** P13 is intentionally a correctness change, separate from parity benchmarks. */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { WorkQueue } = await import(pathToFileURL(join(process.argv[2], "dist/app/queue.js")).href);
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
let active = 0, peak = 0, overlaps = 0;
const keys = new Map<string, number>();
const started: string[] = [];
const queue = new WorkQueue(async (item: string) => {
  const key = item[0];
  if (keys.get(key)) overlaps++;
  keys.set(key, (keys.get(key) ?? 0) + 1);
  active++;
  peak = Math.max(peak, active);
  started.push(item);
  await gate;
  keys.set(key, keys.get(key)! - 1);
  active--;
}, { concurrency: 2 });
for (const item of ["a1", "a2", "a3", "b1"]) queue.push(item[0], item);
const beforeRelease = { activeJobs: active, reportedSize: queue.size, started: [...started] };
release();
await queue.drain();
console.log(JSON.stringify({ concurrencyLimit: 2, peakActiveJobs: peak, sameKeyOverlaps: overlaps, beforeRelease, started, drainedSize: queue.size }, null, 2));
