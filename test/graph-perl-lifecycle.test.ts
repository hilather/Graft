import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync, writeFileSync, statSync, utimesSync, renameSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { perlRepo, runnerSource, utilSource, semanticEdges } from "./helpers/perl-repo.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { extractCachePath, readExtractCache } from "../src/graph/extract-cache.js";
import { probeDrift, isClean, readFingerprint } from "../src/graph/fingerprint.js";
import { readAskIndex } from "../src/ask/index-file.js";
import { ask } from "../src/ask/ask.js";
import type { CruxSummarizer } from "../src/ai/crux.js";
import { initPerlGit } from "./helpers/perl-cli.js";
import { walkDir } from "../src/ingest/fs.js";
import { CODE_EXTENSIONS, listContextFiles } from "../src/context/build.js";
import { writeBuildConfig } from "../src/util/state.js";

test("bounded large Perl modules, shebangs and mappings share discovery without widening native file limits", async () => {
  const padding = "# " + "x".repeat(1_000_020) + "\n";
  const f = perlRepo({
    "large.pm": padding + "package Large; sub work { return 1 }\n",
    "mapped.ts": padding + "package Mapped; sub work { return 2 }\n",
    "bin/large": "#!/usr/bin/perl\n" + padding + "package Script; sub run { return 3 }\n",
    "native.ts": padding + "export function ignored() {}\n",
    "foreign.pl": "#!/usr/bin/python\n" + padding + "def ignored(): pass\n",
  }, { version: 1, files: { "mapped.ts": "perl" } });
  try {
    const expected = ["bin/large", "large.pm", "mapped.ts"];
    for (const mode of ["filesystem", "git", "git-follow"] as const) {
      if (mode === "git") initPerlGit(f.root);
      if (mode === "git-follow") writeBuildConfig(f.root, { followNestedRepos: true });
      const built = await f.build(false);
      assert.equal(built.perl?.failed, 0, JSON.stringify(built.errors));
      assert.deepEqual(f.graph().nodes.filter((node) => node.kind === "file").map((node) => node.path).sort(), expected, mode);
      assert.ok(f.graph().nodes.some((node) => node.id === "large.pm#Large::work"));
      assert.equal((await checkGraph(f.root, { contextDir: f.out })).ok, true);
      assert.deepEqual(listContextFiles(f.root, f.out, CODE_EXTENSIONS).map((path) => path.slice(f.root.length + 1).replaceAll("\\", "/")).sort(), expected);
      assert.ok(!walkDir(f.root).some((path) => expected.some((file) => path === join(f.root, file))), "generic walker retains its original size guard");
    }
    const bytes = f.bytes(), warm = await f.build();
    assert.equal(warm.parsed, 0); assert.equal(warm.perl?.workerStarts, 0); assert.equal(f.bytes(), bytes);
  } finally { f.close(); }
});

test("unreadable Perl classification/full-source inputs stay failed, preserve native nodes and recover without cache poisoning", async (t) => {
  for (const phase of ["prefix", "source"] as const) {
    const f = perlRepo({ "broken.pm": "package Broken; sub work {}", "native.ts": "export function healthy() {}" });
    const target = join(f.root, "broken.pm");
    try {
      await f.build();
      const operation = phase === "prefix" ? "openSync" : "readFileSync";
      const original = fs[operation] as (...args: any[]) => any;
      t.mock.method(fs, operation, (...args: any[]) => {
        if (String(args[0]) === target) throw Object.assign(new Error("fixture read denied"), { code: "EACCES" });
        return original(...args);
      });
      syncBuiltinESMExports();
      const before = f.bytes(); const checked = await checkGraph(f.root, { contextDir: f.out });
      assert.equal(checked.ok, false); assert.match(checked.errors!.join("\n"), /PERL_SOURCE_READ_FAILED/); assert.equal(f.bytes(), before);
      const built = await f.build(); assert.equal(built.perl?.failed, 1); assert.equal(built.perl?.workerStarts, 0);
      assert.ok(f.graph().nodes.some((node) => node.id === "native.ts#healthy"));
      assert.deepEqual(f.graph().nodes.filter((node) => node.path === "broken.pm").map((node) => node.id), ["broken.pm"]);
      assert.equal(readExtractCache(f.out).files["broken.pm"].cacheable, false);
      assert.equal(isClean(probeDrift(f.root, f.out)!), true, "the same unavailable input must not create a refresh loop");
      const repeated = await f.build(); assert.deepEqual(repeated.errors, built.errors);
      t.mock.restoreAll(); syncBuiltinESMExports();
      assert.equal(isClean(probeDrift(f.root, f.out)!), false);
      const recovered = await f.build(); assert.equal(recovered.parsed, 1); assert.deepEqual(recovered.errors, []);
      assert.ok(f.graph().nodes.some((node) => node.id === "broken.pm#Broken::work"));
      const bytes = f.bytes(); await f.build(false); assert.equal(f.bytes(), bytes);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
  }
});

test("an unreadable extensionless classification input is diagnosed without asserting Perl identity", async (t) => {
  const f = perlRepo({ "runner": "#!/usr/bin/perl\nsub run {}" });
  try {
    await f.build();
    const original = fs.openSync;
    t.mock.method(fs, "openSync", (...args: any[]) => {
      if (String(args[0]) === join(f.root, "runner")) throw Object.assign(new Error("fixture read denied"), { code: "EACCES" });
      return (original as (...args: any[]) => any)(...args);
    });
    syncBuiltinESMExports();
    const checked = await checkGraph(f.root, { contextDir: f.out }); assert.equal(checked.ok, false); assert.match(checked.errors!.join("\n"), /SOURCE_CLASSIFICATION_UNAVAILABLE/);
    const failed = await f.build(); assert.match(failed.errors.join("\n"), /SOURCE_CLASSIFICATION_UNAVAILABLE/); assert.equal(f.graph().nodes.length, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.close(); }
});

test("touches, same-stat byte edits, module rename and deletion preserve cold/warm graph and cache identity", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource });
  try {
    await f.build(); const first = f.bytes(); const path = join(f.root, "lib/Acme/Util.pm");
    const stat = statSync(path); utimesSync(path, stat.atime, new Date(stat.mtimeMs + 5_000));
    const touched = await f.build(); assert.equal(touched.parsed, 0); assert.equal(f.bytes(), first);
    const preserved = statSync(path);
    f.write("lib/Acme/Util.pm", utilSource.replace("lc $value", "uc $value")); utimesSync(path, preserved.atime, preserved.mtime);
    const priorRefresh = process.env.GRAFT_REFRESH; process.env.GRAFT_REFRESH = "hash";
    try { assert.ok(probeDrift(f.root, f.out)!.changed.includes("lib/Acme/Util.pm")); }
    finally { if (priorRefresh === undefined) delete process.env.GRAFT_REFRESH; else process.env.GRAFT_REFRESH = priorRefresh; }
    const edited = await f.build(); assert.equal(edited.parsed, 1); const after = f.bytes(); const index = readAskIndex(f.out);
    await f.build(false); assert.equal(f.bytes(), after); assert.deepEqual(readAskIndex(f.out), index);
    renameSync(path, join(f.root, "lib/Acme/Renamed.pm"));
    await f.build(); assert.ok(!semanticEdges(f.graph()).some((edge) => edge.includes("#Acme::Util::normalize")));
    assert.ok(!readExtractCache(f.out).files["lib/Acme/Util.pm"]); assert.ok(!readFingerprint(f.out)!.files["lib/Acme/Util.pm"]);
    assert.ok(!f.graph().edges.some((edge) => edge.target.startsWith("lib/Acme/Util.pm#")));
    rmSync(join(f.root, "lib/Acme/Renamed.pm")); await f.build();
    assert.ok(!f.graph().nodes.some((node) => node.path === "lib/Acme/Renamed.pm"));
    const deleted = f.bytes(); await f.build(false); assert.equal(f.bytes(), deleted);
  } finally { f.close(); }
});

test("Perl enrichment covers source and framework nodes while raw cached facts stay pending", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource, "widget.pm": "package Widget; use Moo; has 'title' => (default => sub { helper() }); sub helper {}" });
  const calls: string[][] = [];
  const summarizer: CruxSummarizer = { async describeFile(input) {
    calls.push(input.nodes.map((node) => node.id));
    return input.nodes.map((node) => ({ id: node.id, summary: `Purpose of ${node.id}`, crux_start: node.id.endsWith("#Acme::Util::normalize") ? 8 : 0, crux_end: node.id.endsWith("#Acme::Util::normalize") ? 8 : 0 }));
  } };
  try {
    await buildGraph(f.root, { contextDir: f.out, summarizer });
    assert.ok(calls.flat().includes("widget.pm#Widget::has(title)"));
    assert.ok(calls.flat().some((id) => id.includes("::has(title).default@scope")));
    const original = f.graph().nodes.find((node) => node.id.endsWith("#Acme::Util::normalize"))!;
    assert.equal(original.summary_state, "ready"); assert.match(original.crux!.code, /return lc \$value/);
    const raw = readExtractCache(f.out);
    for (const entry of Object.values(raw.files)) for (const node of entry.nodes) assert.equal(node.summary_state, "pending");
    assert.ok(raw.files["lib/Acme/Util.pm"].nodes.some((node) => node.body_text?.includes("normalize_sentinel_409")));
    const count = calls.length; const bytes = f.bytes(); await buildGraph(f.root, { contextDir: f.out, summarizer });
    assert.equal(calls.length, count); assert.equal(f.bytes(), bytes);
    f.write("lib/Acme/Util.pm", utilSource.replace("lc $value", "uc $value")); await f.build();
    assert.equal(f.graph().nodes.find((node) => node.id === original.id)!.summary_state, "stale");
    assert.equal(f.graph().nodes.find((node) => node.id === "bin/runner.pl#main::run")!.summary_state, "ready");
    assert.ok(ask(f.root, "normalize_sentinel_409", { contextDir: f.out }).hits.some((hit) => hit.pointer === "lib/Acme/Util.pm:L6-L9"));
  } finally { f.close(); }
});

test("concurrent repository builds keep parser operations, source bodies and cache reuse independent", async () => {
  const a = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource });
  const b = perlRepo({ "lib/Acme/Util.pm": utilSource.replace("normalize_sentinel_409", "other_repository_412"), "bin/runner.pl": runnerSource });
  try {
    const first = await Promise.all([a.build(), b.build()]);
    assert.deepEqual(first.map((result) => result.perl?.workerStarts), [1, 1]);
    const snapshots = [a.bytes(), b.bytes()];
    const bodies = [a, b].map((fixture) => JSON.stringify(readExtractCache(fixture.out).files["lib/Acme/Util.pm"]));
    assert.match(bodies[0], /normalize_sentinel_409/); assert.ok(!bodies[0].includes("other_repository_412"));
    assert.match(bodies[1], /other_repository_412/); assert.ok(!bodies[1].includes("normalize_sentinel_409"));
    const warm = await Promise.all([a.build(), b.build()]);
    assert.deepEqual(warm.map((result) => result.perl?.workerStarts), [0, 0]);
    assert.deepEqual(warm.map((result) => result.parsed), [0, 0]);
    assert.deepEqual([a.bytes(), b.bytes()], snapshots);
  } finally { a.close(); b.close(); }
});

test("old extraction caches invalidate safely and unsupported encoding follows source-decoder exclusion", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource });
  try {
    await f.build(); const cachePath = extractCachePath(f.out)!;
    const cache = JSON.parse(readFileSync(cachePath, "utf8")); cache.version = 1;
    writeFileSync(cachePath, JSON.stringify(cache)); assert.deepEqual(readExtractCache(f.out).files, {});
    const cold = await f.build(); assert.equal(cold.parsed, 2);
    const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0, 35, 0, 32])]);
    writeFileSync(join(f.root, "lib/Acme/Util.pm"), bytes);
    assert.ok(probeDrift(f.root, f.out)!.removed.includes("lib/Acme/Util.pm"));
    await f.build(); assert.ok(!f.graph().nodes.some((node) => node.path === "lib/Acme/Util.pm"));
    f.write("lib/Acme/Util.pm", utilSource); await f.build(); assert.ok(f.graph().nodes.some((node) => node.id.endsWith("#Acme::Util::normalize")));
  } finally { f.close(); }
});
