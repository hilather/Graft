/** Fresh-process WASM retention probe; compiled JS, no timing thresholds. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

interface SoakResult {
  variant: string; sample: number; digest: string; elapsedMs: number; maxRssKiB: number;
  memory: Array<{ rss: number; external: number }>;
}

if (process.argv[2] === "--worker") {
  const variant = resolve(process.argv[3]);
  const generic = await import(pathToFileURL(join(variant, "dist/graph/generic.js")).href);
  await generic.warmGenericGrammars(["rust"]);
  const source = Array.from({ length: 100 }, (_, i) => `pub fn f${i}() { f${(i + 1) % 100}(); f${(i + 2) % 100}(); }`).join("\n");
  const digest = createHash("sha256");
  const memory: Array<{ iteration: number; rss: number; heapUsed: number; external: number; arrayBuffers: number }> = [];
  const sample = (iteration: number) => {
    global.gc?.();
    const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
    memory.push({ iteration, rss, heapUsed, external, arrayBuffers });
  };
  sample(0);
  const start = performance.now();
  for (let i = 1; i <= 600; i++) {
    const result = generic.extractGeneric("src/lib.rs", source, "rust");
    assert.equal(result.nodes.length, 101);
    assert.equal(result.rawEdges.filter((e: { relation: string }) => e.relation === "calls").length, 200);
    digest.update(JSON.stringify(result));
    if (i % 100 === 0) sample(i);
  }
  process.stdout.write(JSON.stringify({ node: process.version, iterations: 600, definitions: 100, calls: 200,
    elapsedMs: performance.now() - start, digest: digest.digest("hex"), memory,
    maxRssKiB: process.resourceUsage().maxRSS }));
} else {
  const [reference, candidate, output] = process.argv.slice(2).map(path => resolve(path));
  mkdirSync(output, { recursive: true });
  const results: SoakResult[] = [];
  for (let sample = 0; sample < 7; sample++) {
    for (const variant of sample % 2 ? ["candidate", "reference"] : ["reference", "candidate"]) {
      const child = spawnSync(process.execPath, ["--expose-gc", process.argv[1], "--worker", variant === "reference" ? reference : candidate], {
        encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
      });
      if (child.status !== 0) throw new Error(`${variant} exited ${child.status}: ${child.stderr}`);
      const result = { variant, sample, ...JSON.parse(child.stdout) };
      writeFileSync(join(output, `${variant}-${sample}.json`), JSON.stringify(result, null, 2) + "\n");
      results.push(result);
    }
  }
  assert.equal(new Set(results.map(r => r.digest)).size, 1, "all extraction outputs must match exactly");
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const report = ["reference", "candidate"].map(variant => {
    const rows = results.filter(r => r.variant === variant);
    return { variant, samples: rows.length,
      medianElapsedMs: median(rows.map(r => r.elapsedMs)),
      medianPeakRssMiB: median(rows.map(r => r.maxRssKiB / 1024)),
      medianRssGrowthMiB: median(rows.map(r => (r.memory.at(-1)!.rss - r.memory[0].rss) / 1024 ** 2)),
      medianExternalGrowthMiB: median(rows.map(r => (r.memory.at(-1)!.external - r.memory[0].external) / 1024 ** 2)),
    };
  });
  writeFileSync(join(output, "summary.json"), JSON.stringify({ exactParity: true, report }, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
