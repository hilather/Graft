import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PerlParser } from "../src/graph/perl-parser.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { wiringPath, readGraph } from "../src/graph/write.js";

function simulated(mode = "normal") {
  const workers: Worker[] = [];
  const factory = () => {
    const worker = new Worker(new URL("./fixtures/perl-worker.mjs", import.meta.url), { workerData: { mode }, execArgv: [] });
    workers.push(worker);
    return worker;
  };
  return { workers, factory };
}

test("Perl worker starts lazily, parses sequentially and disposes after the operation", async () => {
  const parser = new PerlParser();
  assert.equal(parser.workerStarts, 0);
  try {
    const pod = await parser.extract("docs.pod", "=pod\nsub fake {}", "pod");
    assert.equal(pod.status, "ok");
    assert.deepEqual(pod.nodes.map((n) => n.kind), ["file"]);
    assert.equal(parser.workerStarts, 0);
    const results = await Promise.all([parser.extract("a.pm", "package A; sub a {}"), parser.extract("b.pm", "package B; sub b {}")]);
    assert.equal(parser.workerStarts, 1);
    assert.deepEqual(results.map((r) => r.languageData.file), ["a.pm", "b.pm"]);
    for (const result of results) {
      assert.notEqual(result.status, "failed");
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result, "no tree handles or runtime indexes cross the worker");
    }
  } finally { await parser.dispose(); }
  const closed = await parser.extract("later.pm", "sub later {}");
  assert.equal(closed.languageData.diagnostics[0].code, "PERL_PARSER_CLOSED");
  assert.equal(parser.workerStarts, 1);
});

test("the input bound includes two million code units and rejects larger input without poisoning later work", async () => {
  const parser = new PerlParser();
  // Documentation isolates input admission from scanner runtime. An admitted
  // source file still has to finish under the independent worker deadline.
  const source = "=pod\nBoundary documentation\n=cut\n".padEnd(2_000_000, " ");
  try {
    const rejected = await parser.extract("too-large.pod", source + " ", "pod");
    assert.equal(rejected.status, "failed"); assert.equal(rejected.cacheable, false);
    assert.equal(rejected.languageData.diagnostics[0].code, "PERL_INPUT_TOO_LARGE");
    assert.equal(parser.workerStarts, 0);
    const admitted = await parser.extract("boundary.pod", source, "pod");
    assert.equal(admitted.status, "ok"); assert.equal(admitted.nodes.length, 1);
    assert.equal(parser.workerStarts, 0);
    const accepted = await parser.extract("healthy.pm", "package Limit; sub accepted {}");
    assert.ok(accepted.nodes.some((node) => node.id === "healthy.pm#Limit::accepted"));
    assert.equal(parser.workerStarts, 1);
  } finally { await parser.dispose(); }
});

test("a synchronous hang is terminated while the parent stays responsive; queued work recovers", async () => {
  const mock = simulated();
  const parser = new PerlParser({ timeoutMs: 250, workerFactory: mock.factory });
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 10);
  try {
    const [hung, next] = await Promise.all([parser.extract("hung.pm", "hang"), parser.extract("next.pm", "healthy")]);
    assert.equal(hung.status, "failed");
    assert.equal(hung.cacheable, false);
    assert.equal(hung.languageData.diagnostics[0].code, "PERL_PARSE_TIMEOUT");
    assert.ok(ticks > 0);
    assert.equal(mock.workers[0].threadId, -1, "termination completes before failure is returned");
    assert.equal(next.status, "ok");
    assert.equal(next.nodes[0].id, "next.pm");
    assert.equal(parser.workerStarts, 2);
  } finally { clearInterval(ticker); await parser.dispose(); }
  assert.ok(mock.workers.every((w) => w.threadId === -1));
});

test("worker exits fail once, and repeated failures reach a bounded restart limit", async () => {
  const mock = simulated();
  const parser = new PerlParser({ maxRestarts: 1, workerFactory: mock.factory });
  try {
    for (const file of ["a.pm", "b.pm"]) {
      const result = await parser.extract(file, "exit");
      assert.equal(result.languageData.diagnostics[0].code, "PERL_WORKER_EXIT");
      assert.equal(result.nodes[0].path, file);
    }
    const remaining = await parser.extract("remaining.pm", "healthy");
    assert.equal(remaining.languageData.diagnostics[0].code, "PERL_RESTART_LIMIT");
    assert.equal(remaining.cacheable, false);
    assert.equal(parser.workerStarts, 2);
  } finally { await parser.dispose(); }
});

test("startup has its own deadline and pending source jobs are bounded", async () => {
  const mock = simulated("startup-hang");
  const parser = new PerlParser({ startupTimeoutMs: 60, maxPendingJobs: 1, workerFactory: mock.factory });
  try {
    const pending = parser.extract("first.pm", "healthy");
    const full = await parser.extract("extra.pm", "healthy");
    assert.equal(full.languageData.diagnostics[0].code, "PERL_QUEUE_FULL");
    const first = await pending;
    assert.equal(first.languageData.diagnostics[0].code, "PERL_STARTUP_TIMEOUT");
    assert.equal(mock.workers[0].threadId, -1);
  } finally { await parser.dispose(); }
});

test("missing/corrupt/ABI-mismatched assets are visible, and failed initialization is operation-local", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-perl-bad-assets-"));
  try {
    for (const mode of ["missing", "corrupt", "abi"]) {
      const asset = join(root, "tree-sitter-perl.wasm");
      if (mode !== "missing") {
        const manifest = JSON.parse(readFileSync(new URL("../src/graph/grammars/perl/provenance.json", import.meta.url), "utf8"));
        if (mode === "abi") manifest.generator.abi = 14;
        writeFileSync(join(root, "provenance.json"), JSON.stringify(manifest));
        if (mode === "corrupt") writeFileSync(asset, "bad wasm");
        else copyFileSync(new URL("../src/graph/grammars/perl/tree-sitter-perl.wasm", import.meta.url), asset);
      }
      const parser = new PerlParser({ assetsDir: pathToFileURL(root + "/") });
      try {
        for (const file of ["a.pm", "b.pm"]) {
          const result = await parser.extract(file, "package A;");
          assert.equal(result.status, "failed", mode);
          assert.equal(result.cacheable, false);
          assert.equal(result.languageData.diagnostics[0].code, "PERL_ASSET_FAILED");
          assert.equal(result.nodes[0].language, "perl");
        }
        assert.equal(parser.workerStarts, 1, "do not repeatedly load the same broken asset in one operation");
      } finally { await parser.dispose(); }
    }
    const healthy = new PerlParser();
    try { assert.notEqual((await healthy.extract("healthy.pm", "package Healthy;")).status, "failed"); }
    finally { await healthy.dispose(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mixed builds retain malformed Perl file identity and healthy native nodes; check reports errors without repair", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-perl-mixed-errors-"));
  const out = join(root, "context");
  try {
    writeFileSync(join(root, "bad.pm"), "package Broken; sub bad {");
    writeFileSync(join(root, "good.ts"), "export function good() { return 1; }");
    const built = await buildGraph(root, { contextDir: out });
    assert.equal(built.perl?.partial, 1);
    assert.equal(built.perl?.workerStarts, 1);
    assert.ok(built.errors.some((e) => e.includes("PERL_PARSE_ERROR")));
    const graph = readGraph(wiringPath(out))!;
    assert.ok(graph.nodes.some((n) => n.id === "bad.pm" && n.kind === "file" && n.language === "perl"));
    assert.ok(graph.nodes.some((n) => n.id === "good.ts#good"));
    const before = readFileSync(wiringPath(out), "utf8");
    const checked = await checkGraph(root, { contextDir: out });
    assert.equal(checked.ok, false);
    assert.ok(checked.errors?.some((e) => e.includes("PERL_PARSE_ERROR")));
    assert.equal(readFileSync(wiringPath(out), "utf8"), before);
    const warm = await buildGraph(root, { contextDir: out });
    assert.equal(warm.parsed, 0);
    assert.equal(warm.perl?.workerStarts, 0);
    assert.deepEqual(warm.errors, built.errors);
    assert.equal(readFileSync(wiringPath(out), "utf8"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
