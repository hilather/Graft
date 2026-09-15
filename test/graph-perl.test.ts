import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PerlParser } from "../src/graph/perl-parser.js";
import { contentHash } from "../src/util/id.js";
import type { PerlExtractResult } from "../src/graph/perl-types.js";
import { extractPerlTree } from "../src/graph/perl-extract.js";

const fixture = (file: string) => readFileSync(new URL(`./fixtures/perl/${file}`, import.meta.url), "utf8");
async function extract(file: string, source = fixture(file)): Promise<PerlExtractResult> {
  const parser = new PerlParser();
  try { return await parser.extract(file, source); } finally { await parser.dispose(); }
}

test("literal constant names survive computed/list values and scalar hash declarations", async () => {
  const source = [
    "package Constants;",
    "sub compute { return 7 }",
    "use constant COMPUTED => compute();",
    "use constant NONE => ();",
    "use constant MANY => (1, 2, 3);",
    "BEGIN {",
    "  my $i = 0;",
    "  use constant {",
    "    FIRST => $i++, SECOND => $i++, LABEL => 'second',",
    "    'Other::VALUE' => [1, 2], DUP => 1, DUP => 2,",
    "  };",
    "}",
    "sub read_values { (FIRST, SECOND, COMPUTED, NONE, MANY, Other::VALUE()) }",
  ].join("\n");
  const result = await extract("constants.pm", source);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.nodes.filter((n) => n.kind === "constant").map((n) => [n.qualified_name, n.span]), [
    ["Constants::COMPUTED", "L3-L3"], ["Constants::NONE", "L4-L4"], ["Constants::MANY", "L5-L5"],
    ["Constants::FIRST", "L8-L11"], ["Constants::SECOND", "L8-L11"], ["Constants::LABEL", "L8-L11"],
    ["Other::VALUE", "L8-L11"], ["Constants::DUP", "L8-L11"],
  ]);
  const initializer = result.languageData.calls.find((call) => call.name.kind === "known" && call.name.value === "compute")!;
  assert.equal(initializer.range.startLine, 3);
  assert.equal(initializer.phase, "compile");
  assert.ok(result.languageData.definitions.filter((d) => d.kind === "constant").every((d) => d.hasBody && !d.conditional));
});

test("computed constant names and hash list expansion remain explicit and do not invent declarations", async () => {
  const source = "package C; sub values_for_hash { (1, 'SURPRISE', 2) } use constant { FIRST => values_for_hash(), LAST => 3 }; use constant { $name => 1, VISIBLE => 2 }; use constant $name => 7;";
  const result = await extract("dynamic-constants.pm", source);
  assert.deepEqual(result.nodes.filter((n) => n.kind === "constant"), []);
  assert.equal(result.languageData.diagnostics.filter((d) => d.code === "PERL_CONSTANT_UNRESOLVED").length, 3);
  assert.equal(result.status, "partial");
  assert.ok(result.languageData.calls.some((call) => call.name.kind === "known" && call.name.value === "values_for_hash"));
});

test("literal scalar constants and empty invocation syntax retain separate inlining evidence", async () => {
  const result = await extract("inline.pm", [
    "package Inline; use constant NUMBER => 42; use constant TEXT => 'value'; use constant NOTHING => undef;",
    "use constant COMPUTED => calculate(); use constant LIST => (1, 2); use constant REF => [];",
    "use constant { FIRST => 1, SECOND => 'second', DUP => 1, DUP => [], LAST => [], LAST => 2 };",
    "sub read { NUMBER; NUMBER(); &NUMBER(); NUMBER(1); Inline::NUMBER(); Inline->NUMBER(); }",
  ].join("\n"));
  assert.deepEqual(result.languageData.definitions.filter((definition) => definition.inlineConstant).map((definition) => definition.name), ["NUMBER", "TEXT", "NOTHING", "FIRST", "SECOND", "LAST"]);
  const calls = result.languageData.calls.filter((call) => call.name.kind === "known" && call.name.value.endsWith("NUMBER"));
  assert.deepEqual(calls.map((call) => [call.form, call.syntax ?? null, call.emptyArguments ?? false]), [
    ["bare", "bareword", false], ["bare", null, true], ["bare", "ampersand", true],
    ["bare", null, false], ["qualified", null, true], ["method", null, false],
  ]);
});

test("minus-prefixed constant operands have exact guarded spans while quoted keys remain inert", async () => {
  const source = [
    "package Negation; use constant { BASE => 36, STEP => 1 }; sub take {}",
    "sub operands { take -STEP; take(-STEP); &take(-STEP); my $n = - STEP; take((-STEP) => 3); }",
    "sub difference { my $label = '😀'; my $n = BASE - STEP + 1; }",
    "sub strings { take -option; take('-STEP'); take(-STEP => 3); my %h = (-STEP => 3); my $v = $h{-STEP}; my @v = @h{-STEP}; my $r = {-STEP => 3}; }",
  ].join("\n");
  const result = await extract("negation.pm", source);
  const guarded = result.languageData.calls.filter((call) => call.requiresInlineConstant);
  assert.equal(guarded.length, 7);
  assert.ok(guarded.every((call) => call.range.startLine === 2 || call.range.startLine === 3));
  for (const call of guarded) {
    assert.equal(call.name.kind, "known");
    if (call.name.kind === "known") assert.equal(source.slice(call.range.start, call.range.end), call.name.value);
  }
  const step = guarded.find((call) => call.range.startLine === 3 && call.name.kind === "known" && call.name.value === "STEP")!;
  assert.equal(step.range.start, source.indexOf("STEP + 1"));
  assert.deepEqual(step.requiresInlineConstant, { name: "Negation::STEP", position: step.range.start });
});

test("worker input chunks preserve literal bodies, Unicode boundaries, recovery and complete source facts", async () => {
  const { Parser, Language } = await import("web-tree-sitter");
  await Parser.init();
  const language = await Language.load(readFileSync(new URL("../src/graph/grammars/perl/tree-sitter-perl.wasm", import.meta.url)));
  const prefix = "package Chunk;\nsub work {\n  my $value = q{";
  const padding = "x".repeat((63 - prefix.length % 64 + 64) % 64);
  const source = prefix + padding + "😀" + " package False; sub fake {} ".repeat(80) + "};\n  return $value;\n}\nwork();\n";
  assert.equal(source.indexOf("😀") % 64, 63, "surrogate pair straddles a worker input chunk");
  for (const [file, input] of [["chunk.pm", source], ["recovery.pm", "package Broken; sub broken {"], ["islands.pm", fixture("islands.pm")]] as const) {
    const parser = new Parser(); parser.setLanguage(language);
    const tree = parser.parse(input)!;
    try {
      assert.deepEqual(await extract(file, input), extractPerlTree(file, input, tree.rootNode), file);
      if (file === "chunk.pm") assert.deepEqual(extractPerlTree(file, input, tree.rootNode).nodes.map((node) => node.id), [file, `${file}#Chunk`, `${file}#Chunk::work`]);
    } finally { tree.delete(); parser.delete(); }
  }
});

test("F01: package and sub identities, literal loads and Exporter facts are source backed", async () => {
  const file = "f01/lib/Acme/Util.pm";
  const source = fixture(file);
  const result = await extract(file, source);
  assert.deepEqual(result.nodes.map((n) => [n.id, n.kind]), [
    [file, "file"], [file + "#Acme::Util", "module"], [file + "#Acme::Util::normalize", "function"],
  ]);
  const normalize = result.nodes[2];
  assert.equal(normalize.name, "normalize");
  assert.equal(normalize.qualified_name, "Acme::Util::normalize");
  assert.equal(normalize.signature, "sub normalize ($value)");
  assert.equal(normalize.span, "L4-L7");
  assert.equal(normalize.body_hash, contentHash(source.slice(source.indexOf("sub normalize"), source.lastIndexOf("}") + 1)));
  assert.match(normalize.body_text!, /PERL_NORMALIZE_SENTINEL/);
  assert.equal(normalize.exported, true);
  assert.equal(normalize.arity, undefined);
  assert.equal(normalize.owner, undefined);
  assert.equal(result.languageData.loads[0].targetKind, "module");
  assert.deepEqual(result.languageData.loads[0].target, { kind: "known", value: "Exporter" });
  assert.deepEqual(result.languageData.loads[0].arguments, { kind: "list", symbols: ["import"] });
  assert.deepEqual(result.languageData.exports[0].symbols, { kind: "known", value: ["normalize"] });
  assert.equal(result.languageData.exports[0].exporter, "import");
  assert.equal(result.rawEdges.filter((e) => e.relation !== "contains").length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("F03: lexical package restoration, re-entry, forward bodies and competing definitions", async () => {
  const result = await extract("scopes.pm");
  const definitions = result.languageData.definitions;
  assert.deepEqual(definitions.map((d) => d.qualifiedName), [
    "Alpha::same", "Alpha::call_alpha", "Beta::same", "Beta::call_beta", "Alpha::after_block",
    "Gamma::same", "Gamma::call_gamma", "Alpha::final_alpha", "Alpha::later",
    "Alpha::duplicate", "Alpha::duplicate", "Other::entry", "Alpha::still_alpha",
  ]);
  assert.deepEqual(result.languageData.packages.map((p) => p.nodeId), ["scopes.pm#Alpha", "scopes.pm#Beta", "scopes.pm#Gamma", "scopes.pm#Alpha~2"]);
  assert.equal(new Set(result.nodes.map((n) => n.id)).size, result.nodes.length);
  const later = definitions.find((d) => d.qualifiedName === "Alpha::later")!;
  assert.equal(later.hasBody, true);
  assert.deepEqual(later.declarations.map((r) => r.startLine), [16, 17]);
  assert.equal(result.nodes.find((n) => n.id === later.nodeId)!.span, "L17-L17");
  assert.deepEqual(definitions.filter((d) => d.name === "duplicate").map((d) => d.nodeId), ["scopes.pm#Alpha::duplicate", "scopes.pm#Alpha::duplicate~2"]);
  // The qualified declaration names Other::entry; its body still compiles in
  // the lexical Alpha package. Only a package declaration switches that scope.
  const expected = ["Alpha", "Beta", "Alpha", "Gamma", "Alpha", "Alpha", "Alpha"];
  assert.deepEqual(result.languageData.calls.filter((c) => c.name.kind === "known" && c.name.value === "same").map((c) => c.packageName), expected);
  assert.ok(result.nodes.filter((n) => n.kind === "function").every((n) => n.exported === false));
});

test("F05: lexical sub/coderef identity, shadow lifetimes, references and inline callback ownership", async () => {
  const result = await extract("lexical.pm");
  const facts = result.languageData;
  const helper = facts.definitions.find((d) => d.kind === "lexical-sub" && d.name === "helper")!;
  const memo = facts.definitions.find((d) => d.kind === "lexical-sub" && d.name === "memo")!;
  const handler = facts.definitions.find((d) => d.kind === "callback")!;
  assert.ok(helper.nodeId.includes("@scope"));
  assert.ok(memo.nodeId.includes("@scope"));
  assert.equal(handler.name, "$handler");
  assert.equal(facts.definitions.filter((d) => d.kind === "callback").length, 1);
  const binding = facts.bindings.find((b) => b.name === "$handler")!;
  assert.deepEqual(binding.target, { kind: "known", value: { nodeId: handler.nodeId } });
  assert.equal(binding.invalidations[0].reason, "assignment");
  assert.equal(facts.calls.filter((c) => c.form === "coderef").length, 3);
  assert.equal(facts.calls.find((c) => c.range.startLine === 4)!.bindingId, undefined);
  assert.equal(facts.calls.find((c) => c.range.startLine === 16)!.bindingId, undefined, "lexical helper ends at its block");
  const lexicalBinding = facts.bindings.find((b) => b.kind === "lexical-sub" && b.name === "helper")!;
  assert.equal(facts.calls.find((c) => c.range.startLine === 7)!.bindingId, lexicalBinding.id);
  assert.equal(facts.scopes.find((s) => s.id === lexicalBinding.scopeId)!.range.endLine, 15);
  assert.deepEqual(facts.references.map((r) => r.name), [{ kind: "known", value: "Scope::helper" }]);
  assert.equal(facts.calls.filter((c) => c.range.startLine === 19).length, 1, "bare ampersand is a call");
  const inline = facts.calls.find((c) => c.range.startLine === 20 && c.name.kind === "known" && c.name.value === "helper")!;
  assert.equal(inline.sourceNode, "lexical.pm#Scope::outer");
  assert.ok(facts.scopes.some((s) => s.kind === "callback" && s.ownerNode === inline.sourceNode));
  assert.deepEqual(facts.definitions.filter((d) => d.kind === "package-sub").map((d) => d.qualifiedName), ["Scope::helper", "Scope::outer"]);
});

test("lexical declarations become visible after their body, and a prior lexical forward captures the later body", async () => {
  const result = await extract("lexical-forward.pm", "package P; sub local_name {} my sub local_name { local_name() } local_name(); { my sub recursive; sub recursive { recursive() } recursive(); }");
  const facts = result.languageData;
  const localCalls = facts.calls.filter((c) => c.name.kind === "known" && c.name.value === "local_name");
  assert.equal(localCalls[0].bindingId, undefined, "first lexical body still sees the preceding package binding");
  assert.ok(localCalls[1].bindingId);
  const recursive = facts.definitions.filter((d) => d.name === "recursive");
  assert.equal(recursive.length, 1);
  assert.equal(recursive[0].kind, "lexical-sub");
  assert.equal(recursive[0].declarations.length, 2);
  const recursiveCalls = facts.calls.filter((c) => c.name.kind === "known" && c.name.value === "recursive");
  assert.equal(recursiveCalls.length, 2);
  assert.ok(recursiveCalls.every((c) => c.bindingId));
});

test("F07: quotes, multiple heredocs, POD and data never mint fake symbols or intents", async () => {
  const result = await extract("islands.pm");
  assert.deepEqual(result.languageData.packages.map((p) => p.name), ["Real"]);
  assert.deepEqual(result.languageData.definitions.map((d) => d.qualifiedName), ["Real::actual"]);
  assert.deepEqual(result.languageData.calls, []);
  assert.deepEqual(result.languageData.loads, []);
  const ended = await extract("ended.pm", "sub real {}\n__END__\npackage Fake; sub fake { wrong() }\n");
  assert.deepEqual(ended.languageData.definitions.map((d) => d.qualifiedName), ["main::real"]);
  assert.deepEqual(ended.languageData.calls, []);
  const embedded = await extract("embedded.pm", 'sub actual { s/x/replacement_helper()/e; qr/(?{ regex_helper() })/; my $x = "@{[interpolation_helper()]}"; }');
  assert.equal(embedded.languageData.diagnostics.filter((d) => d.code === "PERL_EMBEDDED_CODE_UNSUPPORTED").length, 2);
  assert.deepEqual(embedded.languageData.calls.map(call => call.name.kind === "known" && call.name.value), ["replacement_helper"]);
});

test("F08: UTF-16 source coordinates, CRLF, signatures, prototypes, attributes and versioned packages", async () => {
  const source = "\uFEFF# café 😀\r\npackage Acme::V 1.23;\r\nmy $s = '😀'; sub combine ($$) :lvalue { 1 }\r\nsub multiline\r\n ($first, $second)\r\n { $first }\r\n";
  const result = await extract("positions.pm", source);
  const combine = result.nodes.find((n) => n.name === "combine")!;
  assert.equal(combine.span, "L3-L3");
  assert.equal(combine.signature, "sub combine ($$) :lvalue");
  assert.equal(combine.body_hash, contentHash("sub combine ($$) :lvalue { 1 }"));
  assert.equal(combine.arity, undefined);
  const range = result.languageData.definitions.find((d) => d.name === "combine")!.range;
  assert.equal(source.slice(range.start, range.end), "sub combine ($$) :lvalue { 1 }");
  const multiline = result.nodes.find((n) => n.name === "multiline")!;
  assert.equal(multiline.span, "L4-L6");
  assert.equal(multiline.signature, "sub multiline ($first, $second)");
  assert.equal(result.nodes.find((n) => n.kind === "module")!.signature, "package Acme::V 1.23;");
});

test("load arguments and phases retain empty, unknown, no-import and conditional runtime distinctions", async () => {
  const result = await extract("loads.pm", "use Foo; use Foo (); use Foo qw(a b); use Foo @dynamic; no Foo; use v5.36; require 5.01; if (0) { use Bar; require Baz; } BEGIN { require Early; } do './legacy.pl';");
  const loads = result.languageData.loads;
  assert.deepEqual(loads.slice(0, 4).map((l) => l.arguments.kind), ["default", "empty", "list", "unknown"]);
  assert.equal(loads[4].operation, "no");
  assert.deepEqual(loads.slice(5, 7).map((l) => l.targetKind), ["version", "version"]);
  const bar = loads.find((l) => l.target.kind === "known" && l.target.value === "Bar")!;
  assert.equal(bar.phase, "compile");
  assert.equal(bar.conditional, false);
  const baz = loads.find((l) => l.target.kind === "known" && l.target.value === "Baz")!;
  assert.equal(baz.phase, "runtime");
  assert.equal(baz.conditional, true);
  const early = loads.find((l) => l.target.kind === "known" && l.target.value === "Early")!;
  assert.equal(early.phase, "BEGIN");
  assert.equal(loads.at(-1)!.operation, "do");
  assert.equal(loads.at(-1)!.targetKind, "file");
});

test("source-declared class/method/field/phaser and constants retain their own kinds without inferred constructors", async () => {
  const result = await extract("modern.pm", "class Point :isa(Base) { field $x :param; method get { $x } ADJUST { ready() } } package Constants; use constant ANSWER => 42;");
  assert.deepEqual(result.nodes.map((n) => [n.name, n.kind]), [
    ["modern.pm", "file"], ["Point", "class"], ["$x", "variable"], ["get", "method"], ["ADJUST", "function"], ["Constants", "module"], ["ANSWER", "constant"],
  ]);
  assert.equal(result.nodes.find((n) => n.name === "get")!.owner, "Point");
  assert.deepEqual(result.languageData.inheritance[0].parents, { kind: "known", value: ["Base"] });
  const ready = result.languageData.calls.find((c) => c.name.kind === "known" && c.name.value === "ready")!;
  assert.equal(ready.phase, "ADJUST");
  assert.equal(ready.sourceNode, "modern.pm#Point::ADJUST");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("every normative fixture has plain facts, valid containment and exact definition hashes", async () => {
  for (const file of ["scopes.pm", "lexical.pm", "islands.pm", "f01/lib/Acme/Util.pm", "f01/lib/Acme/Runner.pm"]) {
    const source = fixture(file);
    const result = await extract(file, source);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, file);
    const ids = new Set(result.nodes.map((n) => n.id));
    for (const edge of result.rawEdges) {
      assert.equal(edge.relation, "contains");
      assert.ok(ids.has(edge.source), edge.source);
      assert.ok(ids.has(edge.targetId!), edge.targetId);
      assert.notEqual(edge.source, edge.targetId);
    }
    for (const definition of result.languageData.definitions) {
      assert.equal(result.nodes.find((n) => n.id === definition.nodeId)!.body_hash, contentHash(source.slice(definition.range.start, definition.range.end)));
    }
  }
});

test("partial edits preserve safe declarations, invalidate uncertain packages, and quarantine unterminated literal tails", async () => {
  const ordinary = await extract("recovery.pm", "sub before { 1 }\nmy $x = ;\nsub after { 2 }");
  assert.deepEqual(ordinary.languageData.definitions.map((d) => d.qualifiedName), ["main::before", "main::after"]);
  assert.ok(ordinary.languageData.diagnostics.some((d) => d.code === "PERL_PARSE_ERROR"));
  const packageError = await extract("package-error.pm", "package Safe; sub before { 1 }\npackage 123;\nsub uncertain { 2 }\npackage Good; sub after { 3 }");
  assert.deepEqual(packageError.languageData.definitions.map((d) => d.qualifiedName), ["Safe::before", "Good::after"]);
  assert.ok(packageError.languageData.diagnostics.some((d) => d.code === "PERL_PACKAGE_CONTEXT_UNKNOWN"));
  const quoteError = await extract("quote-error.pm", 'package Safe; sub before { 1 }\nmy $x = "unterminated;\nsub ghost { 2 }\npackage Fake; sub also_fake {}');
  assert.deepEqual(quoteError.languageData.definitions.map((d) => d.qualifiedName), ["Safe::before"]);
  assert.deepEqual(quoteError.languageData.packages.map((p) => p.name), ["Safe"]);
  assert.ok(quoteError.languageData.diagnostics.some((d) => d.code === "PERL_OPAQUE_RECOVERY"));
});

test("exported means supported static availability, including replacement, tags and custom-importer uncertainty", async () => {
  const result = await extract("exports.pm", "package E; use Exporter 'import'; our @EXPORT = qw(old); @EXPORT = qw(current); our @EXPORT_OK = qw(optional); our %EXPORT_TAGS = (all => [qw(current optional)]); sub old {} sub current {} sub optional {} package Custom; use Exporter 'import'; our @EXPORT = qw(work); sub import {} sub work {}");
  assert.deepEqual(result.nodes.filter((n) => n.exported).map((n) => n.qualified_name), ["E::current", "E::optional"]);
  assert.deepEqual(result.languageData.exports.find((e) => e.kind === "tag")!.symbols, { kind: "known", value: ["current", "optional"] });
  assert.equal(result.languageData.exports.find((e) => e.packageName === "Custom")!.exporter, "unknown");
});
