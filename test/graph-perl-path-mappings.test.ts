import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePerlConfig, PerlConfigError } from "../src/graph/perl-config.js";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

const config = (pathMappings: Record<string, string>) => ({ version: 1, projects: [{ root: ".", includeRoots: ["lib"], pathMappings }] });
const diagnostics = (f: ReturnType<typeof perlRepo>) => JSON.parse(readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8")).files;

test("path mappings normalize exact prefixes and reject ambiguous or escaping configuration", () => {
  const mapped = parsePerlConfig(JSON.stringify(config({ "/opt/rt/": "./sources/rt", "/": "." })), []);
  assert.equal(mapped.projects[0].pathMappings?.["/opt/rt"], "sources/rt");
  assert.equal(mapped.projects[0].pathMappings?.["/"], "");
  for (const mappings of [
    { "relative": "lib" }, { "/opt/*": "lib" }, { "/opt\\lib": "lib" },
    { "/opt": "../outside" }, { "/opt": "/host/lib" },
    { "/opt/": "one", "/opt": "two" },
  ]) assert.throws(() => parsePerlConfig(JSON.stringify(config(mappings)), []), PerlConfigError);
});

test("mapped use lib and absolute require resolve visible container sources without a CWD", async () => {
  const f = perlRepo({
    "main.pl": "use lib '/opt/rt3/lib'; use P (); require '/opt/reference/helper.pl'; P::run(); Helper::run();",
    "sources/rt/lib/P.pm": "package P; sub run {} 1;",
    "tools/helper.pl": "package Helper; sub run {} 1;",
  }, config({ "/opt/rt3": "sources/rt", "/opt/reference": "tools" }));
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), [
      "main.pl -> sources/rt/lib/P.pm#P::run [extracted]",
      "main.pl -> tools/helper.pl#Helper::run [extracted]",
    ]);
    assert.deepEqual(diagnostics(f)["main.pl"].diagnostics, []);
  } finally { f.close(); }
});

test("the longest whole path prefix wins and similarly named paths stay outside", async () => {
  const f = perlRepo({
    "main.pl": "require '/rt/lib/local/P.pm'; P::run(); require '/rt/library/Other.pm'; require '/rt/lib/../../outside.pm';",
    "sources/local/P.pm": "package P; sub run {} 1;",
    "sources/base/local/P.pm": "package P; sub run {} 1;",
    "sources/base/rary/Other.pm": "package Other; sub run {} 1;",
  }, config({ "/rt/lib": "sources/base", "/rt/lib/local": "sources/local" }));
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["main.pl -> sources/local/P.pm#P::run [extracted]"]);
    assert.equal(diagnostics(f)["main.pl"].diagnostics.filter((d: any) => d.code === "PERL_MODULE_UNRESOLVED").length, 2);
  } finally { f.close(); }
});

test("changing a mapping recomputes bindings while reusing unchanged extraction", async () => {
  const f = perlRepo({
    "main.pl": "require '/runtime/P.pm'; P::run();",
    "one/P.pm": "package P; sub run {} 1;", "two/P.pm": "package P; sub run {} 1;",
  }, config({ "/runtime": "one" }));
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["main.pl -> one/P.pm#P::run [extracted]"]);
    f.write("graft.perl.json", JSON.stringify(config({ "/runtime": "two" })));
    const warm = await f.build();
    assert.equal(warm.parsed, 0);
    assert.deepEqual(semanticEdges(f.graph()), ["main.pl -> two/P.pm#P::run [extracted]"]);
  } finally { f.close(); }
});

test("a runtime prefix can map directly to the graph root", async () => {
  for (const prefix of ["/runtime", "/"]) {
    const f = perlRepo({ "main.pl": `require '${prefix === "/" ? "" : prefix}/P.pm'; P::run();`, "P.pm": "package P; sub run {} 1;" }, config({ [prefix]: "." }));
    try {
      await f.build();
      assert.deepEqual(semanticEdges(f.graph()), ["main.pl -> P.pm#P::run [extracted]"]);
    } finally { f.close(); }
  }
});

test("mapped dependencies retain cross-project load effects", async () => {
  const f = perlRepo({
    "app/main.pl": "require '/runtime/Mutator.pm'; Mutator::change(); require P; P::run();",
    "app/lib/P.pm": "package P; sub run {} 1;",
    "dep/Mutator.pm": "package Mutator; sub change { @INC = @unknown } 1;",
  }, { version: 1, projects: [
    { root: "app", includeRoots: ["app/lib"], pathMappings: { "/runtime/Mutator.pm": "dep/Mutator.pm" } },
    { root: "dep", includeRoots: ["dep"] },
  ] });
  try {
    await f.build();
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes("#P::run")));
    assert.ok(JSON.stringify(diagnostics(f)).includes("PERL_MODULE_UNRESOLVED"));
  } finally { f.close(); }
});

test("unmapped absolute include paths explain the missing mapping", async () => {
  const f = perlRepo({ "main.pl": "use lib '/missing/container/lib'; require '/missing/container/helper.pl';" });
  try {
    await f.build();
    const text = JSON.stringify(diagnostics(f));
    assert.ok(text.includes("no path mapping"));
    assert.ok(!text.includes("require an explicit analysisCwd"));
  } finally { f.close(); }
});
