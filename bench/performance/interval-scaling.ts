/** Isolates P04's lookup algorithm; does not claim whole-extractor speedups. */
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { smallestEnclosing } = await import(pathToFileURL(join(process.argv[2], "dist/graph/intervals.js")).href);
const definitions = Array.from({ length: 6000 }, (_, id) => ({ id, startIndex: id * 20, endIndex: id * 20 + 19 }));
const offsets = definitions.flatMap((d) => [d.startIndex + 3, d.startIndex + 15]);
// Frozen reference expression from generic.ts: stable smallest-width sort.
const reference = () => offsets.map((at) => definitions.filter((d) => d.startIndex <= at && at < d.endIndex)
  .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0]);
const candidate = () => smallestEnclosing(definitions, offsets);
assert.deepEqual(candidate(), reference());
const samples: object[] = [];
for (let trial = -5; trial < 20; trial++) {
  for (const [variant, run] of trial % 2 ? [["candidate", candidate], ["reference", reference]] as const : [["reference", reference], ["candidate", candidate]] as const) {
    const cpu = process.cpuUsage(), start = performance.now();
    const result = run();
    const durationMs = performance.now() - start, used = process.cpuUsage(cpu);
    assert.equal(result.length, offsets.length);
    if (trial >= 0) samples.push({ variant, trial, durationMs, cpuUserMicros: used.user, cpuSystemMicros: used.system });
  }
}
writeFileSync(process.argv[3], JSON.stringify({ node: process.version, definitions: definitions.length, queries: offsets.length,
  exactParity: true, scope: "isolated interval lookup; excludes parsing, queries and extraction", samples }, null, 2));
