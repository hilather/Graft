import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { perlRepo, utilSource, runnerSource, semanticEdges } from "./helpers/perl-repo.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import { resolvePerlEdges } from "../src/graph/perl-resolve.js";
import { perlImportKey } from "../src/graph/perl-modules.js";
import { PERL_FACTS_VERSION, type PerlFileFacts, type PerlModuleEnvironment, type PerlRange } from "../src/graph/perl-types.js";
import type { NodeV1 } from "../src/graph/types.js";

test("later unique source declarations shadow earlier import uncertainty without erasing later effects", async () => {
  const f = perlRepo({
    "lib/Provider.pm": "package Provider; use Exporter 'import'; our @EXPORT_OK = qw(work); sub work {}",
    "before.pm": "package Before; use Missing; sub work {} sub run { work() }",
    "explicit.pm": "package Explicit; use Missing qw(work); sub work {} sub run { work() }",
    "known.pm": "package Known; use Provider qw(work); sub work {} sub run { work() }",
    "after.pm": "package After; sub work {} use Missing; sub run { work() }",
    "unimport-after.pm": "package UnimportAfter; use Missing; sub work {} no Missing; sub run { work() }",
    "unimport-before.pm": "package UnimportBefore; use Missing; no Missing; sub work {} sub run { work() }",
    "empty-no.pm": "package EmptyNo; use Provider qw(work); no Provider (); sub run { work() }",
    "mutated.pm": "package Mutated; use Missing; sub work {} eval $source; sub run { work() }",
    "duplicate.pm": "package Duplicate; use Missing; sub work {} sub work {} sub run { work() }",
  });
  try {
    await f.build(false);
    assert.deepEqual(semanticEdges(f.graph()), [
      "before.pm#Before::run -> before.pm#Before::work [extracted]",
      "explicit.pm#Explicit::run -> explicit.pm#Explicit::work [extracted]",
      "unimport-before.pm#UnimportBefore::run -> unimport-before.pm#UnimportBefore::work [extracted]",
      "empty-no.pm#EmptyNo::run -> lib/Provider.pm#Provider::work [extracted]",
    ].sort());
    const cold = f.bytes(); const warm = await f.build();
    assert.equal(warm.parsed, 0); assert.equal(f.bytes(), cold);
  } finally { f.close(); }
});

test("straight-line initialization ignores uncalled deferred mutations and retains reachable effects", async () => {
  const cases: [string, string, boolean][] = [
    ["uncalled", "sub mutate { eval $source } work();", true],
    ["later-runtime", "work(); eval $source;", true],
    ["prior-runtime", "eval $source; work();", false],
    ["direct-helper", "sub mutate { eval $source } mutate(); work();", false],
    ["later-helper", "sub mutate { eval $source } work(); mutate();", true],
    ["transitive", "sub mutate { eval $source } sub wrap { mutate() } wrap(); work();", false],
    ["recursive", "sub mutate { eval $source; wrap() } sub wrap { mutate() } wrap(); work();", false],
    ["begin", "sub mutate { eval $source } BEGIN { mutate() } work();", false],
    ["later-begin", "sub mutate { eval $source } work(); BEGIN { mutate() }", false],
    ["unitcheck", "sub mutate { eval $source } UNITCHECK { mutate() } work();", false],
    ["check", "sub mutate { eval $source } CHECK { mutate() } work();", false],
    ["init", "sub mutate { eval $source } INIT { mutate() } work();", false],
    ["nested-argument", "sub mutate { eval $source } work(mutate());", false],
    ["anonymous-callback", "consume(sub { eval $source }); work();", false],
    ["named-callback", "sub mutate { eval $source } consume(\\&mutate); work();", false],
    ["lexical-callback", "my $cb = sub { eval $source }; $cb->(); work();", false],
    ["escaped-callback", "my $cb = sub { eval $source }; consume($cb); work();", false],
    ["dynamic-call", "sub mutate { eval $source } $cb->(); work();", false],
    ["computed-load", "sub mutate { eval $source } require $module; work();", false],
    ["called-loader", "sub mutate { eval $source } sub load { require $module } load(); work();", false],
    ["loop", "while ($again) { work(); eval $source; }", false],
    ["goto", "START: work(); eval $source; goto START;", false],
    ["helper-goto", "sub jump { goto START } START: work(); eval $source; jump();", false],
    ["bare-block-redo", "{ work(); eval $source; redo; }", false],
    ["helper-redo", "sub repeat { redo } { work(); eval $source; repeat(); }", false],
    ["bare-block", "sub mutate { eval $source } { work(); }", true],
    ["quoted-label", "my $text = 'START: goto START'; sub mutate { eval $source } work();", true],
    ["later-sub-body", "sub mutate { eval $source } sub run { work() }", true],
    ["self-mutation", "work();", true],
  ];
  for (const [label, body, expected] of cases) {
    const f = perlRepo({ "init.pm": `package P; sub work { ${label === "self-mutation" ? "eval $source" : ""} } ${body}` });
    try {
      await f.build(false);
      const edges = semanticEdges(f.graph());
      assert.equal(edges.some((edge) => / -> init.pm#P::work \[(extracted|inferred)\]$/.test(edge)), expected, label);
      if (label === "later-sub-body") assert.ok(edges.includes("init.pm#P::run -> init.pm#P::work [inferred]"));
    } finally { f.close(); }
  }
});

test("initialization mutation summaries follow module callbacks and import hooks", async () => {
  const cases: [string, string, string, boolean][] = [
    ["pure-loader", "use Hook ();", "package Hook; sub unused { P::mutate() } 1;", true],
    ["module-body", "use Hook ();", "package Hook; P::mutate(); 1;", false],
    ["import", "use Hook;", "package Hook; sub import { P::mutate() } 1;", false],
    ["empty-import", "use Hook ();", "package Hook; sub import { P::mutate() } 1;", true],
    ["unimport", "no Hook;", "package Hook; sub unimport { P::mutate() } 1;", false],
    ["runtime-loader", "require Hook;", "package Hook; P::mutate(); 1;", false],
  ];
  for (const [label, load, provider, expected] of cases) {
    const f = perlRepo({ "init.pm": `package P; sub work {} sub mutate { eval $source } ${load} work();`, "lib/Hook.pm": provider });
    try {
      await f.build(false);
      assert.equal(semanticEdges(f.graph()).some((edge) => edge.endsWith(" -> init.pm#P::work [extracted]")), expected, label);
      const bytes = f.bytes(); const warm = await f.build();
      assert.equal(warm.parsed, 0); assert.equal(warm.perl?.workerStarts, 0); assert.equal(f.bytes(), bytes);
    } finally { f.close(); }
  }
});

test("assignment targets retain constant indexes, slice/key expressions and lvalue calls", async () => {
  const f = perlRepo({ "targets.pm": [
    "package Targets; use constant IDX => 0;",
    "sub offset { 0 } sub key { 'key' } sub target { {} } sub value { 1 }",
    "sub write {",
    "  my (@array, %hash);",
    "  $array[IDX] = value();",
    "  @array[offset()] = value();",
    "  ($array[offset()], $hash{key()}) = value();",
    "  target()->{key()} = value();",
    "  $hash{'offset()'} = value();",
    "  my $local = value();",
    "}",
  ].join("\n") });
  try {
    const cold = await f.build(false);
    assert.deepEqual(cold.errors, []);
    assert.deepEqual(semanticEdges(f.graph()), ["IDX", "key", "offset", "target", "value"].map((name) => `targets.pm#Targets::write -> targets.pm#Targets::${name} [extracted]`).sort());
    const bytes = f.bytes(); const warm = await f.build();
    assert.equal(warm.parsed, 0); assert.deepEqual(warm.errors, []); assert.equal(f.bytes(), bytes);
  } finally { f.close(); }
});

test("same-unit literal constants keep compiled bindings across runtime mutations without freezing dynamic invocations", async () => {
  const f = perlRepo({ "constants.pm": [
    "package Folded; use Missing; use constant LIST => (1, 2); use constant COMPUTED => calculate(); use constant REF => [];",
    "use constant N => 3; use constant { LABEL => 'label', NOTHING => undef };",
    "sub stable { N; N(); Folded::N(); LABEL(); NOTHING(); }",
    "sub dynamic { &N(); &N(1); Folded->N(); LIST(); COMPUTED(); REF(); \\&N; }",
    "eval $source; *N = $replacement;",
  ].join("\n") });
  try {
    await f.build(false);
    assert.deepEqual(semanticEdges(f.graph()), ["LABEL", "N", "NOTHING"].map((name) => `constants.pm#Folded::stable -> constants.pm#Folded::${name} [extracted]`));
    assert.deepEqual(semanticEdges(f.graph(), "references"), []);
    const cold = f.bytes(); const warm = await f.build();
    assert.equal(warm.parsed, 0); assert.equal(warm.perl?.workerStarts, 0); assert.equal(f.bytes(), cold);
    f.write("constants.pm", "package Folded; use constant N => 3; BEGIN { *N = $replacement; } sub stable { N() }");
    const changed = await f.build(); assert.equal(changed.parsed, 1); assert.deepEqual(semanticEdges(f.graph()), []);
  } finally { f.close(); }
});

test("constant inlining respects compilation position, nested BEGIN order, imports and competing definitions", async () => {
  const cases: [string, string, boolean][] = [
    ["runtime-first", "package C; eval $source; use constant N => 1; sub read { N() }", true],
    ["begin-before", "package C; BEGIN { *N = $replacement; } use constant N => 1; sub read { N() }", true],
    ["begin-after", "package C; use constant N => 1; sub read { N() } BEGIN { *N = $replacement; }", true],
    ["begin-between", "package C; use constant N => 1; BEGIN { *N = $replacement; } sub read { N() }", false],
    ["called-helper", "package C; use constant N => 1; sub replace { *N = $replacement; } BEGIN { replace() } sub read { N() }", false],
    ["transitive-helper", "package C; use constant N => 1; sub replace { eval $source; } sub initialize { replace() } BEGIN { initialize() } sub read { N() }", false],
    ["nested-use", "package C; BEGIN { *N = $replacement; use constant N => 1; } sub read { N() }", false],
    ["declaration-after-call", "package C; sub read { N() } use constant N => 1; eval $source;", false],
    ["later-import", "package C; use constant N => 1; use Missing; sub read { N() } eval $source;", false],
    ["duplicate", "package C; use constant N => 1; use constant N => 2; sub read { N() } eval $source;", false],
  ];
  for (const [label, source, expected] of cases) {
    const f = perlRepo({ "constants.pm": source });
    try {
      await f.build();
      assert.equal(f.graph().edges.some((edge) => edge.relation === "calls" && edge.source === "constants.pm#C::read" && edge.target === "constants.pm#C::N"), expected, label);
    } finally { f.close(); }
  }
  const f = perlRepo({ "constants.pm": "package C; use constant N => 1; BEGIN { N(); *N = $replacement; N(); }" });
  try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["constants.pm#C::BEGIN -> constants.pm#C::N [extracted]"]); }
  finally { f.close(); }
});

test("subtraction and unary constant operands resolve only with compilation-time binding proof", async () => {
  const f = perlRepo({ "constants.pm": [
    "package C; use constant { BASE => 36, STEP => 1 }; sub take {}",
    "sub difference { BASE - STEP; BASE - STEP + 1; }",
    "sub operand { take -STEP; take(-STEP); &take(-STEP); my $value = -STEP; }",
    "sub quoted { take '-STEP'; take(-STEP => 3); my %h = (-STEP => 3); my $v = $h{-STEP}; }",
    "eval $source; *BASE = $replacement;",
  ].join("\n") });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), [
      "constants.pm#C::difference -> constants.pm#C::BASE [extracted]",
      "constants.pm#C::difference -> constants.pm#C::STEP [extracted]",
      "constants.pm#C::operand -> constants.pm#C::STEP [extracted]",
    ]);
    const bytes = f.bytes(); const warm = await f.build(); assert.equal(warm.parsed, 0); assert.equal(f.bytes(), bytes);
    f.write("constants.pm", "package C; use constant { BASE => 36, STEP => 1 }; BEGIN { *BASE = $replacement; } sub difference { BASE - STEP } ");
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["constants.pm#C::difference -> constants.pm#C::STEP [extracted]"]);
    f.write("constants.pm", "package C; use constant { BASE => 36, STEP => 1 }; BEGIN { *STEP = $replacement; } sub difference { BASE - STEP } ");
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["constants.pm#C::difference -> constants.pm#C::BASE [extracted]"]);
    f.write("constants.pm", "package C; use constant STEP => 1; sub replace { eval $source; } BEGIN { replace() } sub read { -STEP } ");
    await f.build(); assert.ok(!f.graph().edges.some((edge) => edge.relation === "calls" && edge.target === "constants.pm#C::STEP"));
    f.write("constants.pm", "package C; sub take {} sub read { take -STEP; } use constant STEP => 1;");
    await f.build(); assert.ok(!f.graph().edges.some((edge) => edge.relation === "calls" && edge.target === "constants.pm#C::STEP"), "a later declaration cannot turn an already parsed string into an operand");
  } finally { f.close(); }
});

test("print, printf and say filehandle blocks preserve real calls without indirect-dispatch warnings", async () => {
  const operators = ["print", "printf", "say", "CORE::print", "CORE::printf", "CORE::say"];
  const source = [
    "package Output; use feature 'say';",
    "sub handle { return *STDOUT } sub value { return 1 }",
    // Ordinary declarations do not turn output operators into user calls.
    "sub print {} sub printf {} sub say {}",
    ...operators.map((operator, i) => `sub output_${i} { ${operator} { handle() } ${operator.endsWith("printf") ? "'%s', " : ""}value(); }`),
    "sub bare_handle { print STDOUT value(); }",
    "sub lexical_handle { my $fh; print {$fh} value(); }",
  ].join("\n");
  const f = perlRepo({ "output.pm": source });
  try {
    const built = await f.build(false);
    assert.deepEqual(built.errors, []);
    const expected = operators.flatMap((_, i) => ["handle", "value"].map((callee) => `output.pm#Output::output_${i} -> output.pm#Output::${callee} [extracted]`));
    expected.push("output.pm#Output::bare_handle -> output.pm#Output::value [extracted]", "output.pm#Output::lexical_handle -> output.pm#Output::value [extracted]");
    assert.deepEqual(semanticEdges(f.graph()), expected.sort());
    const cold = f.bytes(); const warm = await f.build();
    assert.equal(warm.parsed, 0); assert.deepEqual(warm.errors, []); assert.equal(f.bytes(), cold);
  } finally { f.close(); }
});

test("independent frozen-fact oracle preserves imported provenance and refuses unknown or missing endpoints", () => {
  const range: PerlRange = { start: 0, end: 100, startLine: 1, endLine: 5 };
  const facts = (file: string): PerlFileFacts => ({ language: "perl", version: PERL_FACTS_VERSION, file, packages: [], definitions: [], scopes: [{ id: `${file}:scope`, parent: null, kind: "file", ownerNode: file, range, contextKnown: true }], bindings: [], loads: [], includeEffects: [], mutations: [], exports: [], calls: [], references: [], inheritance: [], frameworks: [], diagnostics: [] });
  const entry = facts("entry.pm"), provider = facts("lib/M.pm");
  const site = { sourceNode: "entry.pm#main::run", packageName: "main", scopeId: "entry.pm:scope", range: { ...range, start: 40, end: 50 }, phase: "runtime" as const, conditional: false };
  entry.calls.push({ ...site, form: "bare", name: { kind: "known", value: "work" } });
  entry.loads.push({ ...site, sourceNode: entry.file, range: { ...range, start: 0, end: 20 }, id: "load0", operation: "use", phase: "compile", targetKind: "module", target: { kind: "known", value: "M" }, arguments: { kind: "list", symbols: ["work"] } });
  provider.definitions.push({ nodeId: "lib/M.pm#M::work", name: "work", qualifiedName: "M::work", packageName: "M", packageNode: null, scopeId: "lib/M.pm:scope", kind: "package-sub", range, declarations: [range], hasBody: true, conditional: false });
  const node = (id: string): NodeV1 => ({ id, name: id.split("::").at(-1)!, path: id.split("#")[0], kind: id.includes("#") ? "function" : "file", language: "perl", span: "L1-L5", signature: null, exported: false, origin: "ast", body_hash: "handcrafted", summary_state: "pending", summary: null, crux: null });
  const nodes = [node(entry.file), node(site.sourceNode), node(provider.file), node("lib/M.pm#M::work")];
  const files = new Map([[entry.file, entry], [provider.file, provider]]);
  const key = perlImportKey(entry.file, "main", "work");
  const env: PerlModuleEnvironment = {
    loads: new Map([["load0", { file: provider.file, confidence: "inferred", root: "lib" }]]),
    packageFiles: new Map([["M", [provider.file]]]),
    reachableFiles: new Map([[entry.file, new Set([entry.file, provider.file])], [provider.file, new Set([provider.file])]]),
    reachability: new Map([[entry.file, new Map([[entry.file, "extracted"], [provider.file, "inferred"]])], [provider.file, new Map([[provider.file, "extracted"]])]]),
    imports: new Map([[key, [{ file: entry.file, packageName: "main", name: "work", providerFile: provider.file, providerPackage: "M", exportedName: "work", confidence: "inferred", loadId: "load0" }]]]),
    unknownImports: new Set(), unresolved: [],
  };
  const before = JSON.stringify([...files]);
  const calls = (result: ReturnType<typeof resolvePerlEdges>) => result.edges.filter((e) => e.relation === "calls");
  assert.deepEqual(calls(resolvePerlEdges(nodes, files, env)), [{ source: site.sourceNode, target: "lib/M.pm#M::work", relation: "calls", confidence: "inferred" }]);
  assert.deepEqual(calls(resolvePerlEdges(nodes, files, { ...env, unknownImports: new Set([key]) })), []);
  assert.deepEqual(calls(resolvePerlEdges(nodes.slice(0, -1), files, env)), []);
  assert.deepEqual(calls(resolvePerlEdges([...nodes.slice(0, -1), { ...nodes.at(-1)!, language: "typescript" }], files, env)), []);
  assert.equal(JSON.stringify([...files]), before, "resolution leaves source facts untouched");
});

test("F01: exact configured module load and imported call, with no builtin or pragma fallback", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource, "lib/strict.pm": "package strict; sub normalize {}", "foreign.ts": "export function lc() {}" });
  try {
    await f.build();
    const graph = f.graph();
    assert.deepEqual(semanticEdges(graph), [
      "bin/runner.pl -> bin/runner.pl#main::run [extracted]",
      "bin/runner.pl#main::run -> lib/Acme/Util.pm#Acme::Util::normalize [extracted]",
    ]);
    assert.ok(semanticEdges(graph, "imports").includes("bin/runner.pl -> lib/Acme/Util.pm [extracted]"));
    assert.ok(!graph.edges.some((e) => e.relation === "imports" && ["strict", "warnings", "lib/strict.pm"].includes(e.target)));
    assert.equal(graph.nodes.find((n) => n.id === "lib/Acme/Util.pm#Acme::Util::normalize")!.span, "L6-L9");
    assert.deepEqual(checkGraphInvariants(graph).problems, []);
  } finally { f.close(); }
});

test("F01: inferred conventional roots remain inferred through imported calls", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource }, null);
  try {
    await f.build();
    assert.ok(semanticEdges(f.graph()).includes("bin/runner.pl#main::run -> lib/Acme/Util.pm#Acme::Util::normalize [inferred]"));
    assert.ok(semanticEdges(f.graph(), "imports").includes("bin/runner.pl -> lib/Acme/Util.pm [inferred]"));
  } finally { f.close(); }
});

test("F02: empty use and require load a file without establishing a bare-name import", async () => {
  for (const load of ["use Acme::Util ();", "require Acme::Util;"]) {
    const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "lib/Other.pm": "package Other::Util; sub normalize {}", "main.pl": load + " sub run { normalize('X') } sub qualified { Acme::Util::normalize('X') }" });
    try {
      await f.build();
      assert.deepEqual(semanticEdges(f.graph()), ["main.pl#main::qualified -> lib/Acme/Util.pm#Acme::Util::normalize [extracted]"]);
      assert.ok(semanticEdges(f.graph(), "imports").includes("main.pl -> lib/Acme/Util.pm [extracted]"));
    } finally { f.close(); }
  }
});

test("F03: package-local calls follow scope restoration and duplicate bodies stay ambiguous", async () => {
  const scopes = readFileSync(new URL("./fixtures/perl/scopes.pm", import.meta.url), "utf8");
  const f = perlRepo({ "scopes.pm": scopes + "\nsub conflict { duplicate() } sub forward_caller { later() }\n" });
  try {
    await f.build();
    const endpoints = f.graph().edges.filter((e) => e.relation === "calls").map((e) => [e.source.split("#")[1], e.target.split("#")[1]]);
    assert.deepEqual(endpoints.sort(), [
      ["Alpha::call_alpha", "Alpha::same"], ["Beta::call_beta", "Beta::same"], ["Alpha::after_block", "Alpha::same"], ["Gamma::call_gamma", "Gamma::same"],
      ["Alpha::final_alpha", "Alpha::same"], ["Other::entry", "Alpha::same"], ["Alpha::still_alpha", "Alpha::same"], ["Alpha::forward_caller", "Alpha::later"],
    ].sort());
  } finally { f.close(); }
});

test("F05: lexical shadowing, callbacks and named references resolve only inside proven lifetimes", async () => {
  const f = perlRepo({ "lexical.pm": "package P; sub helper {} sub outer { { my sub helper {} helper(); my $cb = sub { helper() }; $cb->(); &$cb(); $cb = unknown(); $cb->(); } helper(); \\&P::helper; &helper; }" });
  try {
    await f.build();
    const graph = f.graph();
    const lexical = graph.nodes.find((n) => n.name === "helper" && n.id.includes("@scope"))!;
    const callback = graph.nodes.find((n) => n.name === "$cb")!;
    const targets = graph.edges.filter((e) => e.source === "lexical.pm#P::outer" && e.relation === "calls").map((e) => e.target).sort();
    assert.deepEqual(targets, [lexical.id, callback.id, "lexical.pm#P::helper"].sort());
    assert.ok(graph.edges.some((e) => e.source === callback.id && e.target === lexical.id && e.relation === "calls"));
    assert.deepEqual(semanticEdges(graph, "references"), ["lexical.pm#P::outer -> lexical.pm#P::helper [extracted]"]);
    assert.deepEqual(checkGraphInvariants(graph).problems, []);
  } finally { f.close(); }
});

test("callback reassignment and escape never resolve later invocations to the original callback", async () => {
  for (const mutation of ["$cb = replacement();", "escape($cb);"]) {
    const f = perlRepo({ "callback.pm": `sub outer { my $cb = sub {}; ${mutation} $cb->(); &$cb(); }` });
    try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), []); }
    finally { f.close(); }
  }
});

test("F05: standalone main scripts cannot borrow siblings, while an explicit file load supplies context", async () => {
  const f = perlRepo({ "a.pl": "sub run { helper() }", "b.pl": "sub helper {}" });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), []);
    f.write("a.pl", "require './b.pl'; sub run { helper() }");
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["a.pl#main::run -> b.pl#main::helper [extracted]"]);
  } finally { f.close(); }
});

test("import aliases survive lexical blocks; conflicting imports and local declarations do not acquire arbitrary priority", async () => {
  const provider = (pkg: string) => `package ${pkg}; use Exporter 'import'; our @EXPORT_OK = qw(work); sub work {}`;
  const f = perlRepo({ "lib/A.pm": provider("A"), "lib/B.pm": provider("B"), "main.pl": "{ use A qw(work); } sub run { work() }" });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["main.pl#main::run -> lib/A.pm#A::work [extracted]"]);
    f.write("main.pl", "use A qw(work); use B qw(work); sub run { work() }");
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), []);
    f.write("main.pl", "use A qw(work); sub work {} sub run { work() }");
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), []);
  } finally { f.close(); }
});

test("qualified names are case-sensitive and never fall back to a bare or unrelated global name", async () => {
  const f = perlRepo({ "names.pm": "package Foo; sub work {} package foo; sub work {} package Caller; sub run { Foo::work(); foo::work(); Missing::work(); }" });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["names.pm#Caller::run -> names.pm#Foo::work [extracted]", "names.pm#Caller::run -> names.pm#foo::work [extracted]"]);
  } finally { f.close(); }
});

test("CORE, computed calls, AUTOLOAD and typeglob mutation cannot invent concrete call targets", async () => {
  const f = perlRepo({ "dynamic.pm": "package P; sub open {} sub target {} sub AUTOLOAD {} sub run { CORE::open('x'); $object->$method(); missing(); } *target = $replacement; sub later { target() }", "other.ts": "export function missing() {}" });
  try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), []); }
  finally { f.close(); }
});

test("BEGIN calls cannot borrow declarations or imports that compile later", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "main.pl": "sub early {} BEGIN { early(); late(); normalize('X') } sub late {} use Acme::Util qw(normalize); BEGIN { late(); normalize('Y') }" });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), [
      "main.pl#main::BEGIN -> main.pl#main::early [extracted]",
      "main.pl#main::BEGIN~2 -> lib/Acme/Util.pm#Acme::Util::normalize [extracted]",
      "main.pl#main::BEGIN~2 -> main.pl#main::late [extracted]",
    ]);
  } finally { f.close(); }
});

test("barewords require prior declaration/import proof, while ampersand calls and references retain their syntax", async () => {
  const f = perlRepo({ "bare.pm": "package P; my $string = later; sub later {} sub declared {} sub run { declared; &later; \\&later; }" });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["bare.pm#P::run -> bare.pm#P::declared [extracted]", "bare.pm#P::run -> bare.pm#P::later [extracted]"]);
    assert.deepEqual(semanticEdges(f.graph(), "references"), ["bare.pm#P::run -> bare.pm#P::later [extracted]"]);
  } finally { f.close(); }
});

test("top-level runtime calls require a preceding load, and conditional competing bodies remain ambiguous", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "main.pl": "Acme::Util::normalize('before'); require Acme::Util; sub work {} if ($flag) { sub work {} } sub run { work() }" });
  try {
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), []);
    f.write("main.pl", "require Acme::Util; Acme::Util::normalize('after'); sub work {} if ($flag) { sub work {} } sub run { work() }");
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["main.pl -> lib/Acme/Util.pm#Acme::Util::normalize [extracted]"]);
  }
  finally { f.close(); }
});

test("builtin names require explicit override evidence; ordinary declarations and default imports do not override them", async () => {
  const f = perlRepo({ "builtins.pm": "package P; sub push {} sub lc {} sub plain { push @a, 1; lc('X') } sub amp { &push(); &lc() } use subs qw(push lc); sub overridden { push @a, 2; lc('Y') }" });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["builtins.pm#P::amp -> builtins.pm#P::lc [extracted]", "builtins.pm#P::amp -> builtins.pm#P::push [extracted]", "builtins.pm#P::overridden -> builtins.pm#P::lc [extracted]", "builtins.pm#P::overridden -> builtins.pm#P::push [extracted]"]);
  } finally { f.close(); }
  for (const [args, expected] of [["", []], ["qw(push)", ["main.pl#main::run -> lib/M.pm#M::push [extracted]"]]] as const) {
    const imported = perlRepo({ "lib/M.pm": "package M; use Exporter 'import'; our @EXPORT = qw(push); sub push {}", "main.pl": `use M ${args}; sub run { push @a, 1 }` });
    try { await imported.build(); assert.deepEqual(semanticEdges(imported.graph()), expected); }
    finally { imported.close(); }
  }
});

test("string eval reports uncertainty instead of retaining a possibly replaced package target", async () => {
  const f = perlRepo({ "dynamic.pm": "package P; sub work {} eval $source; sub run { work() }" });
  try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), []); }
  finally { f.close(); }
});
