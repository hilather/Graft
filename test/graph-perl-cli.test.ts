import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { perlRepo, runnerSource, utilSource } from "./helpers/perl-repo.js";
import { perlCli } from "./helpers/perl-cli.js";
import type { AskResult, SkeletonResult } from "../src/ask/ask.js";
import type { GrepResult } from "../src/search/grep.js";

test("built CLI returns exact Perl source, qualified skeletons, grep ownership, traversal and map totals", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource + "\nsub entry { run() }\n", "other.pm": "package Other; sub normalize {}", "bin/negative.pl": "use strict; sub missing_import { normalize('PAYLOAD'); }", "bin/handler": "#!/usr/bin/perl\nmy $handler = sub { return 1 }; $handler->();" });
  try {
    await f.build();
    const json = <T>(args: string[]): T => {
      const result = perlCli(f, [...args, f.root, "--json"]);
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout) as T;
    };
    const result = json<AskResult>(["ask", "normalize_sentinel_409", "--source", "--full"]);
    assert.equal(result.hits[0].pointer, "lib/Acme/Util.pm:L6-L9");
    assert.match(result.hits[0].title, /Acme::Util::normalize/);
    assert.equal(result.hits[0].code, utilSource.split("\n").slice(5, 9).join("\n"));
    const warm = json<AskResult>(["ask", "normalize_sentinel_409", "--source", "--full"]);
    assert.deepEqual(warm.hits, result.hits);
    const skeleton = json<SkeletonResult>(["skeleton", "lib/Acme/Util.pm"]);
    assert.deepEqual(skeleton.entries.map((entry) => entry.name), ["Acme::Util", "Acme::Util::normalize"]);
    assert.equal(skeleton.entries[1].signature, "sub normalize");
    assert.equal(skeleton.entries[1].span, "L6-L9");
    const grep = json<GrepResult>(["grep", "normalize_sentinel_409", "--fixed"]);
    assert.equal(grep.totalHits, 1); assert.equal(grep.groups[0].symbol?.id, "lib/Acme/Util.pm#Acme::Util::normalize");
    assert.equal(grep.groups[0].symbol?.name, "Acme::Util::normalize");
    assert.equal(grep.groups[0].hits[0].line, 8); assert.equal(grep.groups[0].inDegree, 1);
    const incoming = json<AskResult>(["ask", "who calls Acme::Util::normalize"]);
    assert.equal(incoming.mode, "structural");
    assert.deepEqual(incoming.hits.map((hit) => hit.pointer), ["bin/runner.pl:L4-L6"]);
    const outgoing = json<AskResult>(["ask", "what does main::run call"]);
    assert.equal(outgoing.mode, "structural");
    assert.deepEqual(outgoing.hits.map((hit) => hit.pointer), ["lib/Acme/Util.pm:L6-L9"]);
    const fullId = json<AskResult>(["ask", "who calls lib/Acme/Util.pm#Acme::Util::normalize"]);
    assert.deepEqual(fullId.hits, incoming.hits);
    type Callers = { matches: { symbol: { id: string }; hits: { id: string; relation: string; depth: number }[] }[] };
    const utilId = "lib/Acme/Util.pm#Acme::Util::normalize";
    const caller = json<Callers>(["callers", "Acme::Util::normalize"]);
    assert.deepEqual(caller.matches.map((match) => match.symbol.id), [utilId]);
    assert.deepEqual(caller.matches[0].hits.map(({ id, relation, depth }) => ({ id, relation, depth })), [{ id: "bin/runner.pl#main::run", relation: "calls", depth: 1 }]);
    assert.deepEqual(json<Callers>(["callers", utilId]).matches, caller.matches);
    const transitive = json<Callers>(["callers", "main::entry", "--direction", "out", "--depth", "2"]);
    assert.deepEqual(transitive.matches[0].hits.filter((hit) => hit.relation === "calls").map(({ id, depth }) => ({ id, depth })).sort((a, b) => a.id.localeCompare(b.id)), [{ id: "bin/runner.pl#main::run", depth: 1 }, { id: utilId, depth: 2 }]);
    assert.equal(f.graph().edges.find((edge) => edge.source === "bin/runner.pl#main::run" && edge.target === utilId && edge.relation === "calls")?.confidence, "extracted");
    assert.notEqual(perlCli(f, ["callers", "acme::util::normalize", f.root, "--json"]).status, 0);
    const sigil = json<AskResult>(["ask", "$handler"]);
    assert.ok(sigil.hits.some((hit) => hit.pointer.startsWith("bin/handler:")));
    const map = json<{ totals: { files: number; symbols: number; languages: string[] } }>(["map"]);
    assert.deepEqual(map.totals.languages, ["perl"]); assert.equal(map.totals.files, 5);
    assert.equal(map.totals.symbols, f.graph().nodes.filter((node) => node.kind !== "file").length);
    const missing = perlCli(f, ["callers", "Missing::normalize", f.root]);
    assert.notEqual(missing.status, 0); assert.ok(!missing.stdout.includes("bin/runner.pl"));
    const scoped = json<AskResult>(["ask", "normalize_sentinel_409", "--in", "lib/Acme"]);
    assert.ok(scoped.hits.every((hit) => hit.pointer.startsWith("lib/Acme/")));
    assert.deepEqual(json<AskResult>(["ask", "normalize_sentinel_409", "--in", join("lib", "Acme")]).hits, scoped.hits);
    const badPrefix = perlCli(f, ["grep", "normalize", f.root, "--in", "missing-prefix", "--fixed", "--json"]);
    assert.notEqual(badPrefix.status, 0); assert.match(badPrefix.stderr, /missing-prefix/);
  } finally { f.close(); }
});

test("CLI freshness reports an edit without repairing it and the next query refreshes", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource });
  try {
    await f.build();
    const clean = perlCli(f, ["check", f.root, "--json"]); assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    f.write("lib/Acme/Util.pm", utilSource.replace("normalize_sentinel_409", "edited_sentinel_410"));
    const before = f.bytes(); const stale = perlCli(f, ["check", f.root, "--json"]);
    assert.notEqual(stale.status, 0); assert.equal(f.bytes(), before);
    const updated = perlCli(f, ["ask", "edited_sentinel_410", f.root, "--source", "--full", "--json"]);
    assert.equal(updated.status, 0, updated.stderr); assert.match(JSON.parse(updated.stdout).hits[0].code, /edited_sentinel_410/);
    assert.notEqual(f.bytes(), before);
  } finally { f.close(); }
});
