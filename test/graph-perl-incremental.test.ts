import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { wiringPath, readGraph } from "../src/graph/write.js";
import { extractCachePath, readExtractCache, stampDir, stampPerlAssets } from "../src/graph/extract-cache.js";
import { isClean, probeDrift } from "../src/graph/fingerprint.js";
import { readAskIndex } from "../src/ask/index-file.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import { SourceDispatcher } from "../src/graph/source-dispatch.js";

test("shared dispatch preserves synchronous native extraction and isolated asynchronous Perl extraction", async () => {
  const dispatcher = new SourceDispatcher();
  try {
    const native = dispatcher.extract("native.ts", "export function healthy() {}", { kind: "native", language: "typescript", native: "typescript", reason: "extension" });
    assert.ok(!(native instanceof Promise));
    assert.ok(native.nodes.some((node) => node.id === "native.ts#healthy"));
    assert.equal(dispatcher.perlWorkerStarts, 0);
    const perl = dispatcher.extract("module.pm", "package Module; sub healthy {}", { kind: "perl", language: "perl", mode: "source", reason: "extension" });
    assert.ok(perl instanceof Promise);
    assert.ok((await perl).nodes.some((node) => node.id === "module.pm#Module::healthy"));
    assert.equal(dispatcher.perlWorkerStarts, 1);
  } finally { await dispatcher.dispose(); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "graft-perl-incremental-"));
  const out = join(root, "context");
  const write = (path: string, content: string | Buffer) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  const build = (reuse = true) => buildGraph(root, { contextDir: out, reuse });
  const graph = () => readFileSync(wiringPath(out), "utf8");
  return { root, out, write, build, graph, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("normative Perl declarations retain exact graph, ask-index and diagnostic identity across cold/warm builds and edits", async () => {
  const f = fixture();
  try {
    cpSync(new URL("./fixtures/perl/", import.meta.url), f.root, { recursive: true });
    const cold = await f.build(false);
    const graph = f.graph();
    const ask = readAskIndex(f.out);
    assert.ok(ask);
    assert.deepEqual(checkGraphInvariants(readGraph(wiringPath(f.out))!).problems, []);
    const memoPath = extractCachePath(f.out)!;
    const memoBytes = readFileSync(memoPath);
    utimesSync(memoPath, new Date(1_000), new Date(1_000));
    const memoMtime = statSync(memoPath).mtimeMs;
    const warm = await f.build();
    assert.equal(warm.parsed, 0);
    assert.equal(warm.reused, cold.files);
    assert.equal(warm.perl?.workerStarts, 0);
    assert.equal(f.graph(), graph);
    assert.deepEqual(readAskIndex(f.out), ask);
    assert.deepEqual(warm.errors, cold.errors);
    assert.equal(statSync(memoPath).mtimeMs, memoMtime, "unchanged raw extraction data is not rewritten");
    assert.deepEqual(readFileSync(memoPath), memoBytes);
    const source = readFileSync(join(f.root, "scopes.pm"), "utf8");
    f.write("scopes.pm", source.replace("sub later ($$) { 4 }", "sub later ($$) { 42 }"));
    const edited = await f.build();
    assert.equal(edited.parsed, 1);
    const afterEdit = f.graph();
    const editedAsk = readAskIndex(f.out);
    const reset = await f.build(false);
    assert.equal(f.graph(), afterEdit);
    assert.deepEqual(readAskIndex(f.out), editedAsk);
    assert.deepEqual(edited.errors, reset.errors);
  } finally { f.close(); }
});

test("Perl file facts replay without a worker; source decoding and cold/warm graph bytes agree", async () => {
  const f = fixture();
  try {
    f.write("lib/A.pm", "package A; sub run { 1 }");
    f.write("bin/tool", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("#!/usr/bin/env perl\r\npackage Tool; sub run { 1 }", "utf16le")]));
    const cold = await f.build(false);
    const bytes = f.graph();
    assert.equal(cold.files, 2);
    assert.equal(cold.perl?.workerStarts, 1);
    const cache = readExtractCache(f.out);
    for (const file of ["lib/A.pm", "bin/tool"]) {
      assert.equal(cache.files[file].languageData?.language, "perl");
      assert.equal(cache.files[file].languageData?.file, file);
    }
    const disk = JSON.parse(readFileSync(extractCachePath(f.out)!, "utf8"));
    assert.deepEqual(disk.files, cache.files);
    assert.ok(isClean(probeDrift(f.root, f.out)!));
    const warm = await f.build();
    assert.equal(warm.parsed, 0);
    assert.equal(warm.reused, 2);
    assert.equal(warm.perl?.workerStarts, 0);
    assert.equal(f.graph(), bytes);
    assert.deepEqual(warm.errors, cold.errors);
  } finally { f.close(); }
});

test("excluded candidates, shebang changes and project markers enter and leave the same refreshed file set", async () => {
  const f = fixture();
  try {
    f.write("bin/tool", "#!/bin/sh\nexit 0\n");
    f.write("t/plain.t", "foo();");
    f.write("lib/plain.pl", "foo();");
    await f.build();
    assert.equal(readGraph(wiringPath(f.out))!.nodes.length, 0);
    f.write("bin/tool", "#!/usr/bin/perl\nsub run {}\n");
    assert.ok(probeDrift(f.root, f.out)!.added.includes("bin/tool"));
    await f.build();
    f.write("cpanfile", "# marker; never executed\n");
    const drift = probeDrift(f.root, f.out)!;
    assert.equal(drift.inputsChanged, true);
    assert.ok(drift.added.includes("t/plain.t"));
    assert.ok(drift.added.includes("lib/plain.pl"));
    await f.build();
    rmSync(join(f.root, "cpanfile"));
    f.write("bin/tool", "#!/bin/sh\nexit 0\n");
    assert.deepEqual(probeDrift(f.root, f.out)!.removed.sort(), ["bin/tool", "cpanfile", "lib/plain.pl", "t/plain.t"]);
    await f.build();
    assert.equal(readGraph(wiringPath(f.out))!.nodes.length, 0);
  } finally { f.close(); }
});

test("config-only changes require analysis refresh and cannot reuse a different language classification", async () => {
  const f = fixture();
  try {
    f.write("source.ts", "export function source() { return 1; }");
    await f.build();
    f.write("graft.perl.json", JSON.stringify({ version: 1, files: { "source.ts": "perl" } }));
    assert.equal(probeDrift(f.root, f.out)!.inputsChanged, true);
    const checked = await checkGraph(f.root, { contextDir: f.out });
    assert.equal(checked.ok, false);
    assert.equal(checked.analysisChanged, true);
    const forced = await f.build();
    assert.equal(forced.parsed, 1);
    assert.equal(forced.perl?.files, 1);
    assert.equal(readExtractCache(f.out).files["source.ts"].languageData?.language, "perl");
    rmSync(join(f.root, "graft.perl.json"));
    const restored = await f.build();
    assert.equal(restored.parsed, 1);
    assert.equal(restored.perl, undefined);
    assert.ok(readGraph(wiringPath(f.out))!.nodes.some((n) => n.id === "source.ts#source"));
  } finally { f.close(); }
});

test("missing parser assets do not poison cache reuse or unrelated-language builds", async () => {
  const f = fixture();
  try {
    f.write("good.ts", "export function good() { return 1; }");
    const unavailable = { assetsDir: pathToFileURL(join(f.root, "missing-assets") + "/") };
    const native = await buildGraph(f.root, { contextDir: f.out, perlParser: unavailable });
    assert.equal(native.perl, undefined);
    assert.deepEqual(native.errors, []);
    f.write("A.pm", "package A; sub run {}");
    const broken = await buildGraph(f.root, { contextDir: f.out, perlParser: unavailable });
    assert.equal(broken.perl?.failed, 1);
    assert.equal(readExtractCache(f.out).files["A.pm"].cacheable, false);
    const repaired = await f.build();
    assert.equal(repaired.parsed, 1);
    assert.equal(repaired.reused, 1);
    assert.equal(repaired.perl?.failed, 0);
    const incremental = f.graph();
    await f.build(false);
    assert.equal(f.graph(), incremental);
  } finally { f.close(); }
});

test("Perl ownership survives only-dir filtering and ordered roots invalidate analysis without reparsing files", async () => {
  const f = fixture();
  try {
    f.write("app/cpanfile", "# distribution marker outside the selected directory\n");
    f.write("app/t/plain.t", "run();\n");
    f.write("other/t/plain.t", "run();\n");
    const options = { contextDir: f.out, onlyDirs: ["app/t"] };
    const first = await buildGraph(f.root, options);
    assert.equal(first.files, 1);
    assert.equal(first.perl?.files, 1);
    assert.deepEqual(Object.keys(readExtractCache(f.out).files), ["app/t/plain.t"]);
    assert.ok(isClean(probeDrift(f.root, f.out)!));
    const config = (includeRoots: string[]) => JSON.stringify({ version: 1, projects: [{ root: "app", includeRoots }] });
    f.write("graft.perl.json", config(["app/lib", "vendor/lib"]));
    assert.equal(probeDrift(f.root, f.out)!.inputsChanged, true);
    const configured = await buildGraph(f.root, options);
    assert.equal(configured.parsed, 0);
    assert.equal(configured.reused, 1);
    f.write("graft.perl.json", config(["vendor/lib", "app/lib"]));
    assert.equal(probeDrift(f.root, f.out)!.inputsChanged, true);
    const reordered = await buildGraph(f.root, options);
    assert.equal(reordered.parsed, 0);
    assert.equal(reordered.perl?.workerStarts, 0);
    assert.ok(isClean(probeDrift(f.root, f.out)!));
  } finally { f.close(); }
});

test("native-only build and check never create a Perl worker", async () => {
  const f = fixture();
  try {
    f.write("main.ts", "export function main() { return 1; }");
    const options = { contextDir: f.out, perlParser: { workerFactory: () => { throw new Error("unexpected Perl worker"); } } };
    const built = await buildGraph(f.root, options);
    assert.equal(built.perl, undefined);
    assert.deepEqual(built.errors, []);
    assert.equal((await checkGraph(f.root, options)).ok, true);
  } finally { f.close(); }
});

test("extractor identity covers nested helpers, grammar bytes and provenance, including restored metadata", () => {
  const f = fixture();
  try {
    f.write("extract.js", "code");
    f.write("helpers/resolve.js", "original");
    const original = stampDir(f.root, ".js");
    f.write("helpers/resolve.js", "modified");
    assert.notEqual(stampDir(f.root, ".js"), original);
    f.write("assets/parser.wasm", "original");
    f.write("assets/provenance.json", "{}");
    const dir = join(f.root, "assets");
    const first = stampPerlAssets(dir);
    const metadata = statSync(join(dir, "parser.wasm"));
    f.write("assets/parser.wasm", "modified");
    utimesSync(join(dir, "parser.wasm"), metadata.atime, metadata.mtime);
    assert.notEqual(stampPerlAssets(dir), first);
    const second = stampPerlAssets(dir);
    f.write("assets/provenance.json", '{"version":2}');
    assert.notEqual(stampPerlAssets(dir), second);
    rmSync(dir, { recursive: true });
    const missing = stampPerlAssets(dir);
    f.write("assets/parser.wasm", "restored");
    assert.notEqual(stampPerlAssets(dir), missing);
  } finally { f.close(); }
});
