/** Reproducible local release measurements. Never downloads or executes Perl. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  corpus: { type: "string" }, output: { type: "string" }, package: { type: "string" },
  mode: { type: "string", default: "all" }, repetitions: { type: "string", default: "5" },
  "child-mode": { type: "string" },
} });
const packageDir = resolve(values.package ?? fileURLToPath(new URL("../", import.meta.url)));
const corpus = values.corpus && resolve(values.corpus);
const repetitions = Number(values.repetitions);
const modes = ["startup", "extract", "build", "memory"];
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1, "--repetitions must be a positive integer");
assert.ok(values.mode === "all" || values.mode === "native" || modes.includes(values.mode), "--mode must be all, startup, extract, build, memory or native");
assert.ok(!values["child-mode"] || values["child-mode"] === "native" || modes.includes(values["child-mode"]), "Invalid child mode");
assert.ok(corpus && values.output, "Usage: node scripts/bench-perl.mjs --corpus DIR --output FILE [--mode all|startup|extract|build|memory|native] [--package DIR]");
const manifestBytes = readFileSync(join(corpus, "graft-benchmark-corpus.json"));
const manifest = JSON.parse(manifestBytes);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const outside = rel => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
const readInput = path => {
  const abs = resolve(corpus, path), rel = relative(corpus, abs);
  assert.ok(rel && !outside(rel), `Invalid corpus path: ${path}`);
  return readFileSync(abs);
};
// The coordinator verifies all source hashes once. Startup and small-parse
// memory children do not load the unrelated large corpus into their baseline.
const needsSources = !values["child-mode"] || ["extract", "build", "native"].includes(values["child-mode"]);
const sources = manifest.files.map(file => {
  if (!needsSources) return file;
  const bytes = readInput(file.path);
  assert.equal(bytes.length, file.bytes, file.path);
  assert.equal(hash(bytes), file.sha256, file.path);
  return { ...file, source: bytes.toString("utf8") };
});
const sourceBytes = sources.reduce((sum, file) => sum + file.bytes, 0);
const config = readInput("graft.perl.json");
assert.equal(hash(config), manifest.configSha256, "Corpus project configuration changed");
const importModule = path => import(pathToFileURL(join(packageDir, "dist", path)).href);
const probe = "package Graft::Benchmark; sub helper { return 1 } sub run { helper() }\n";
const resource = () => ({ memory: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS, cpu: process.cpuUsage() });
const collect = () => { for (let i = 0; i < 3; i++) global.gc?.(); };
const median = values => { const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

async function child(mode) {
  if (mode === "build" || mode === "native") {
    const { buildGraph } = await importModule("graph/build.js");
    const scratch = mkdtempSync(join(tmpdir(), "graft-perl-bench-"));
    try {
      for (const file of sources) {
        const target = join(scratch, file.path); mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(corpus, file.path), target);
      }
      writeFileSync(join(scratch, "graft.perl.json"), config);
      const contextDir = join(scratch, "graft");
      const expectedFiles = new Set(sources.map(file => file.path));
      const run = async reuse => {
        const cpuBefore = process.cpuUsage();
        const started = performance.now();
        const result = await buildGraph(scratch, { contextDir, reuse });
        const ms = performance.now() - started;
        const cpuMicros = process.cpuUsage(cpuBefore);
        if (mode === "native") {
          assert.equal(result.perl?.workerStarts ?? 0, 0, "Native benchmark started a Perl worker");
          assert.ok(!result.languages.includes("perl"), "Native benchmark discovered Perl input");
        }
        const graphBytes = readFileSync(result.graphPath), graph = JSON.parse(graphBytes);
        const actualFiles = new Set(graph.nodes.filter(node => node.kind === "file").map(node => node.path));
        return { ms, cpuMicros, parsed: result.parsed, reused: result.reused, files: result.files, nodes: result.nodes, edges: result.edges, cards: result.cards, perl: result.perl ?? null, errors: result.errors, missingFiles: [...expectedFiles].filter(path => !actualFiles.has(path)), unexpectedFiles: [...actualFiles].filter(path => !expectedFiles.has(path)), graphSha256: hash(graphBytes), resource: resource() };
      };
      const cold = await run(false), warm = await run(true);
      return { mode, cold, warm, graphIdentical: cold.graphSha256 === warm.graphSha256 };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  const { PerlParser } = await importModule("graph/perl-parser.js");
  const parser = new PerlParser();
  try {
    const start = performance.now();
    const initialized = await parser.extract("benchmark.pm", probe);
    const firstMs = performance.now() - start;
    assert.notEqual(initialized.status, "failed", JSON.stringify(initialized.languageData.diagnostics));
    if (mode === "startup") {
      const warmMs = [];
      for (let i = 0; i < 20; i++) { const t = performance.now(); await parser.extract("benchmark.pm", probe); warmMs.push(performance.now() - t); }
      return { mode, firstMs, warmParseMedianMs: median(warmMs), addedMs: Math.max(0, firstMs - median(warmMs)), workerStarts: parser.workerStarts, resource: resource() };
    }
    if (mode === "memory") {
      // Initial WASM compilation allocations can still be retiring after fifty
      // requests. Warm through the observed plateau before recording retained RSS.
      for (let i = 1; i < 500; i++) {
        await parser.extract("benchmark.pm", probe);
        if (i % 100 === 0) collect();
      }
      collect(); const before = resource(), samples = [];
      for (let i = 1; i <= 1000; i++) {
        const parsed = await parser.extract("benchmark.pm", probe);
        assert.notEqual(parsed.status, "failed");
        if (i % 100 === 0) { collect(); samples.push({ parses: i, ...resource() }); }
      }
      collect(); const after = resource();
      return { mode, warmedParses: 500, measuredParses: 1000, parentExplicitGc: !!global.gc, workerExplicitGc: false, before, samples, after, rssGrowthBytes: after.memory.rss - before.memory.rss, workerStarts: parser.workerStarts };
    }
    const files = [], startExtract = performance.now();
    for (const file of sources) {
      const t = performance.now(), result = await parser.extract(file.path, file.source);
      files.push({ path: file.path, bytes: file.bytes, ms: performance.now() - t, status: result.status, cacheable: result.cacheable, nodes: result.nodes.length, diagnostics: result.languageData.diagnostics });
    }
    const ms = performance.now() - startExtract;
    const failed = files.filter(file => file.status === "failed");
    const successfulBytes = sourceBytes - failed.reduce((sum, file) => sum + file.bytes, 0);
    return { mode, ms, sourceBytes, successfulBytes, mibPerSecond: successfulBytes / 1048576 / (ms / 1000), failed: failed.length, partial: files.filter(file => file.status === "partial").length, files, workerStarts: parser.workerStarts, resource: resource() };
  } finally { await parser.dispose(); }
}

if (values["child-mode"]) {
  const result = await child(values["child-mode"]);
  process.stdout.write(JSON.stringify(result) + "\n");
} else {
  const output = resolve(values.output);
  assert.ok(outside(relative(corpus, output)), "Put benchmark output outside the immutable input corpus");
  mkdirSync(dirname(output), { recursive: true });
  const selected = values.mode === "all" ? modes : [values.mode];
  const distDigest = createHash("sha256");
  const stampDist = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(dir, entry.name), rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) stampDist(path, `${rel}/`);
      else if (entry.isFile()) distDigest.update(rel).update("\0").update(hash(readFileSync(path))).update("\n");
    }
  };
  stampDist(join(packageDir, "dist"));
  const report = {
    version: 1, at: new Date().toISOString(), node: process.version,
    host: { platform: platform(), release: release(), arch: process.arch, cpus: cpus().map(({ model, speed }) => ({ model, speed })), memoryBytes: totalmem() },
    packageDir, packageVersion: JSON.parse(readFileSync(join(packageDir, "package.json"))).version,
    compiledDistSha256: distDigest.digest("hex"), driverSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    grammarSha256: existsSync(join(packageDir, "dist/graph/grammars/perl/tree-sitter-perl.wasm")) ? hash(readFileSync(join(packageDir, "dist/graph/grammars/perl/tree-sitter-perl.wasm"))) : null,
    manifestSha256: hash(manifestBytes), files: sources.length, sourceBytes, repetitions,
    method: "Fresh Node child per repetition; one discarded warm-up per mode; startup/memory children do not preload corpus source; extraction starts after one successful parser request; full cold/warm builds include cards and sidecars; build inputs copied to disposable directories outside timing; RSS is process-wide, external/heap figures are parent-only.",
    runs: {}, summaries: {},
  };
  const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  const runChild = mode => new Promise((resolveChild, reject) => {
    const processChild = spawn(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--corpus", corpus, "--output", output, "--package", packageDir, "--child-mode", mode], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { processChild.kill(); reject(new Error(`${mode} exceeded the 15-minute benchmark child deadline`)); }, 900000);
    processChild.stdout.on("data", chunk => { stdout += chunk; });
    processChild.stderr.on("data", chunk => { stderr += chunk; });
    processChild.on("error", error => { clearTimeout(timeout); reject(error); });
    processChild.on("close", code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`${mode} exited ${code}: ${stderr}\n${stdout.slice(-2000)}`));
      try { resolveChild(JSON.parse(stdout)); } catch { reject(new Error(`Invalid ${mode} output: ${stdout.slice(-2000)}\n${stderr}`)); }
    });
  });
  save();
  for (const mode of selected) {
    process.stderr.write(`${mode}: discarded warm-up\n`); await runChild(mode);
    const runs = report.runs[mode] = [];
    const count = mode === "startup" ? Math.max(20, repetitions) : repetitions;
    for (let i = 0; i < count; i++) {
      process.stderr.write(`${mode}: repetition ${i + 1}/${count}\n`);
      runs.push(await runChild(mode)); save();
    }
    if (mode === "startup") report.summaries.startup = { medianAddedMs: median(runs.map(run => run.addedMs)), p95AddedMs: percentile(runs.map(run => run.addedMs), 0.95) };
    if (mode === "extract") report.summaries.extract = { medianMs: median(runs.map(run => run.ms)), medianMiBPerSecond: median(runs.map(run => run.mibPerSecond)), failedPerRun: runs.map(run => run.failed) };
    if (mode === "build" || mode === "native") report.summaries[mode] = { coldMedianMs: median(runs.map(run => run.cold.ms)), warmMedianMs: median(runs.map(run => run.warm.ms)), warmToColdRatio: median(runs.map(run => run.warm.ms)) / median(runs.map(run => run.cold.ms)), allGraphsIdentical: runs.every(run => run.graphIdentical), allExpectedFilesIndexed: runs.every(run => !run.cold.missingFiles.length && !run.cold.unexpectedFiles.length && !run.warm.missingFiles.length && !run.warm.unexpectedFiles.length), warmReparsed: runs.map(run => run.warm.parsed), warmWorkerStarts: runs.map(run => run.warm.perl?.workerStarts ?? 0) };
    if (mode === "memory") report.summaries.memory = { medianRssGrowthBytes: median(runs.map(run => run.rssGrowthBytes)), maxRssGrowthBytes: Math.max(...runs.map(run => run.rssGrowthBytes)) };
    save();
  }
  process.stdout.write(JSON.stringify({ output, summaries: report.summaries }) + "\n");
}
