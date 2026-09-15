import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";
import { extractCachePath } from "../src/graph/extract-cache.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import { checkGraph } from "../src/graph/check.js";

test("Moo and Moose expose literal source attributes and contained default/modifier callbacks", async () => {
  for (const framework of ["Moo", "Moose"]) {
    const f = perlRepo({ "widget.pm": `package Widget; use ${framework}; has 'title' => (is => 'ro', default => sub { helper() }); sub helper {} sub render {} before 'render' => sub { helper() }; after 'render' => sub { helper() }; around 'render' => sub { helper() };` });
    try {
      await f.build(); const graph = f.graph();
      const attribute = graph.nodes.find((n) => n.id === "widget.pm#Widget::has(title)")!;
      assert.equal(attribute.kind, "variable"); assert.match(attribute.signature!, /^has 'title'/);
      const callbacks = graph.nodes.filter((n) => /::(?:has\(title\)\.default|before\(render\)|after\(render\)|around\(render\))@scope/.test(n.id));
      assert.equal(callbacks.length, 4);
      for (const cb of callbacks) {
        assert.ok(graph.edges.some((e) => e.source === "widget.pm#Widget" && e.target === cb.id && e.relation === "contains"));
        assert.ok(graph.edges.some((e) => e.source === cb.id && e.target === "widget.pm#Widget::helper" && e.relation === "calls"));
      }
      assert.deepEqual(semanticEdges(graph, "references"), ["widget.pm#Widget -> widget.pm#Widget::render [extracted]"]);
      assert.ok(!graph.nodes.some((n) => n.name === "new" || n.kind === "function" && n.name === "title"));
      assert.deepEqual(checkGraphInvariants(graph).problems, []);
      const bytes = f.bytes(); const warm = await f.build(); assert.equal(warm.parsed, 0); assert.equal(f.bytes(), bytes);
      const cache = JSON.parse(readFileSync(extractCachePath(f.out)!, "utf8"));
      assert.ok(cache.files["widget.pm"].languageData.frameworks.length >= 5);
      assert.ok(cache.files["widget.pm"].languageData.frameworks.flatMap((d: { attributes?: { summary_state: string }[] }) => d.attributes ?? []).every((n: { summary_state: string }) => n.summary_state === "pending"));
    } finally { f.close(); }
  }
});

test("framework extends loads parents, replaces earlier parents, and retains source-defined inherited methods", async () => {
  const f = perlRepo({ "lib/A.pm": "package A; use Moo; sub render {}", "lib/B.pm": "package B; use Moo; sub render {}", "child.pm": "package Child; use Moo; extends 'A'; extends 'B'; sub run { Child->render() }" });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["child.pm#Child::run -> lib/B.pm#B::render [extracted]"]);
    assert.deepEqual(semanticEdges(f.graph(), "extends"), ["child.pm#Child -> lib/B.pm#B [extracted]"]);
  } finally { f.close(); }
});

test("Moo/Moose roles remain module nodes and composition creates references, not invented methods", async () => {
  for (const framework of ["Moo", "Moose"]) {
    const f = perlRepo({ "lib/Role.pm": `package Role; use ${framework}::Role; has 'flag' => (is => 'ro'); sub role_method {}`, "consumer.pm": `package Consumer; use ${framework}; with 'Role'; sub run { Consumer->role_method(); Consumer->flag(); Consumer->new() }` });
    try {
      await f.build(); const graph = f.graph();
      assert.equal(graph.nodes.find((n) => n.id === "lib/Role.pm#Role")!.kind, "module");
      assert.ok(semanticEdges(graph, "references").includes("consumer.pm#Consumer -> lib/Role.pm#Role [extracted]"));
      assert.deepEqual(semanticEdges(graph), []);
      assert.ok(!graph.nodes.some((n) => n.path === "consumer.pm" && ["role_method", "flag", "new"].includes(n.name)));
    } finally { f.close(); }
  }
});

test("ordinary keyword functions outside framework context keep normal bindings", async () => {
  const f = perlRepo({ "plain.pm": "package Plain; sub has {} sub with {} sub extends {} sub run { has('x'); with('Role'); extends('Base') }" });
  try {
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["plain.pm#Plain::run -> plain.pm#Plain::extends [extracted]", "plain.pm#Plain::run -> plain.pm#Plain::has [extracted]", "plain.pm#Plain::run -> plain.pm#Plain::with [extracted]"]);
    assert.ok(!f.graph().nodes.some((n) => n.id.includes("::has(")));
  } finally { f.close(); }
});

test("framework activation follows packages, import arguments and no/unimport boundaries", async () => {
  const f = perlRepo({ "boundaries.pm": "package A; use Moo; has 'a' => (is => 'ro'); { package B; sub has {} has('b'); } has 'again' => (is => 'ro'); no Moo; has('outside'); package C; use Moo (); has('c'); package D; use MyMoo; has('d');" });
  try { await f.build(); assert.deepEqual(f.graph().nodes.filter((n) => n.kind === "variable").map((n) => n.id).sort(), ["boundaries.pm#A::has(a)", "boundaries.pm#A::has(again)"]); }
  finally { f.close(); }
});

test("a local custom Moo importer cannot materialize framework attributes or inheritance", async () => {
  const f = perlRepo({ "lib/Moo.pm": "package Moo; sub import {}", "lib/Base.pm": "package Base; sub work {}", "main.pm": "package Main; use Moo; has 'attr' => (is => 'ro'); extends 'Base'; sub run { Main->work() }" });
  try { await f.build(); assert.ok(!f.graph().nodes.some((n) => n.id.includes("::has("))); assert.deepEqual(semanticEdges(f.graph()), []); assert.deepEqual(semanticEdges(f.graph(), "extends"), []); }
  finally { f.close(); }
});

test("generated accessors and modifier wrappers never fall through to an inherited source method", async () => {
  for (const declaration of ["has 'render' => (is => 'ro');", "has 'x' => (is => 'ro', reader => 'render');", "around 'render' => sub { 1 };", "with 'Role';"]) {
    const f = perlRepo({ "lib/Base.pm": "package Base; sub render {}", "lib/Role.pm": "package Role; use Moo::Role; sub render {}", "main.pm": `package Main; use Moo; extends 'Base'; ${declaration} sub run { Main->render() }` });
    try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), [], declaration); }
    finally { f.close(); }
  }
});

test("computed framework declarations preserve diagnostics and cannot invent attributes or targets", async () => {
  const f = perlRepo({ "main.pm": "package Main; use Moose; has attribute_name() => (is => 'ro'); extends parent_name(); with role_name(); around method_name() => sub {}; sub run { Main->render() }" });
  try {
    const result = await f.build();
    assert.equal(result.perl?.partial, 1);
    // The CLI excerpt is bounded to three messages; the sidecar retains all
    // binding and framework diagnostics for the same source file.
    const diagnostics = readFileSync(join(f.out, ".cache", "perl-diagnostics.json"), "utf8");
    assert.match(diagnostics, /PERL_FRAMEWORK_DECLARATION_UNKNOWN/);
    assert.ok(!f.graph().nodes.some((n) => n.kind === "variable")); assert.deepEqual(semanticEdges(f.graph()), []);
  }
  finally { f.close(); }
});

test("changing only framework identity recomputes materialized nodes and check reports drift without repair", async () => {
  const f = perlRepo({ "widget.pm": "package Widget; use Moo; has 'title' => (is => 'ro');" });
  try {
    await f.build(); assert.ok(f.graph().nodes.some((n) => n.id === "widget.pm#Widget::has(title)"));
    f.write("lib/Moo.pm", "package Moo; sub import {}");
    const before = f.bytes(); const checked = await checkGraph(f.root, { contextDir: f.out }); assert.equal(checked.ok, false); assert.equal(f.bytes(), before);
    const warm = await f.build(); assert.equal(warm.parsed, 1); assert.ok(!f.graph().nodes.some((n) => n.id === "widget.pm#Widget::has(title)"));
    const bytes = f.bytes(); await f.build(false); assert.equal(f.bytes(), bytes);
  } finally { f.close(); }
});

test("callback loads stay inside their execution scope even without an emitted callback node", async () => {
  const f = perlRepo({
    "lib/Hidden.pm": "package Hidden; sub inside {} sub outside {}",
    "main.pm": "package Main; sub register {} register(sub { require Hidden; Hidden::inside() }); Hidden::outside(); sub outer { register(sub { require Hidden; Hidden::inside() }); Hidden::outside() }",
  });
  try {
    await f.build();
    const calls = semanticEdges(f.graph());
    assert.ok(calls.includes("main.pm -> lib/Hidden.pm#Hidden::inside [extracted]"));
    assert.ok(calls.includes("main.pm#Main::outer -> lib/Hidden.pm#Hidden::inside [extracted]"));
    assert.ok(!calls.some((edge) => edge.includes("#Hidden::outside")));
  } finally { f.close(); }
});

test("framework default callbacks retain local load ordering without lending reachability to other methods", async () => {
  const f = perlRepo({ "lib/Hidden.pm": "package Hidden; sub inside {} sub outside {}", "main.pm": "package Main; use Moo; has 'item' => (default => sub { require Hidden; Hidden::inside() }); sub run { Hidden::outside() }" });
  try {
    await f.build();
    const calls = semanticEdges(f.graph());
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^main.pm#Main::has\(item\)\.default@scope\d+ -> lib\/Hidden.pm#Hidden::inside \[extracted\]$/);
  } finally { f.close(); }
});

test("a framework-generated constructor cannot fall through to a parent's source constructor", async () => {
  const f = perlRepo({ "lib/Base.pm": "package Base; sub new {}", "main.pm": "package Main; use Moo; extends 'Base'; sub run { Main->new() }" });
  try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), []); }
  finally { f.close(); }
});

test("implicit generated writers, predicates and clearers cannot inherit unrelated source bodies", async () => {
  const f = perlRepo({ "lib/Base.pm": "package Base; sub _set_item {} sub has_item {} sub clear_item {}", "main.pm": "package Main; use Moo; extends 'Base'; has 'item' => (is => 'rwp', predicate => 1, clearer => 1); sub run { Main->_set_item(); Main->has_item(); Main->clear_item() }" });
  try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), []); }
  finally { f.close(); }
});

test("a modifier of a generated accessor cannot reference an earlier overwritten source sub", async () => {
  const f = perlRepo({ "main.pm": "package Main; use Moo; sub render {} has 'render' => (is => 'ro'); before 'render' => sub {}; sub run { Main->render() }" });
  try { await f.build(); assert.deepEqual(semanticEdges(f.graph(), "references"), []); assert.deepEqual(semanticEdges(f.graph()), []); }
  finally { f.close(); }
});

test("role modifiers and attributes invalidate affected consumer bodies without copying role methods", async () => {
  for (const declaration of ["around 'render' => sub {};", "has 'render' => (is => 'ro');", "with 'Nested';"]) {
    const f = perlRepo({ "lib/Nested.pm": "package Nested; use Moo::Role; around 'render' => sub {};", "lib/Role.pm": `package Role; use Moo::Role; ${declaration}`, "main.pm": "package Main; use Moo; with 'Role'; sub render {} sub helper {} sub run { Main->render(); Main->helper() }" });
    try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["main.pm#Main::run -> main.pm#Main::helper [extracted]"], declaration); }
    finally { f.close(); }
  }
});
