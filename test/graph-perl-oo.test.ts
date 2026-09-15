/** F06 OO expectations are source oracles, never executed Perl. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

test("core class isa can use an already declared class in the same file", async () => {
  const f = perlRepo({ "local.pm": "use feature 'class'; class Base { method work {} } class Child :isa(Base) { method run { $self->work() } }" });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["local.pm#Child::run -> local.pm#Base::work [inferred]"]);
    assert.deepEqual(semanticEdges(f.graph(), "extends"), ["local.pm#Child -> local.pm#Base [extracted]"]);
  } finally { f.close(); }
});

test("field initializers own their calls and cannot establish file-wide module availability", async () => {
  const f = perlRepo({ "lib/Hidden.pm": "package Hidden; sub inside {} sub outside {}", "class.pm": "use feature 'class'; class Widget { field $item = do { require Hidden; Hidden::inside(); $self->helper() }; method helper {} method run { Hidden::outside() } }" });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["class.pm#Widget::$item -> class.pm#Widget::helper [inferred]", "class.pm#Widget::$item -> lib/Hidden.pm#Hidden::inside [extracted]"]);
    assert.match(f.graph().nodes.find((n) => n.id === "class.pm#Widget::$item")!.signature!, /require Hidden/);
  } finally { f.close(); }
});

test("runtime MRO helpers and deferred ISA changes cannot leave a falsely exact inherited target", async () => {
  for (const effect of ["mro::set_mro('Child', mode());", "mro::set_mro(class_name(), 'c3');", "sub register {} register(sub { @Child::ISA = ('Missing') });"]) {
    const f = perlRepo({ "lib/Base.pm": "package Base; sub work {}", "main.pm": `package Child; use parent 'Base'; ${effect} sub run { Child->work() }` });
    try { const result = await f.build(); assert.deepEqual(semanticEdges(f.graph()).filter((edge) => edge.includes("#Base::work")), [], effect); assert.ok(result.perl?.partial); }
    finally { f.close(); }
  }
});
import { checkGraphInvariants } from "../src/graph/invariants.js";

test("F06: parent loads its module and literal package dispatch finds an inherited ordinary sub", async () => {
  const f = perlRepo({ "lib/Base.pm": "package Base; sub render {}", "lib/Child.pm": "package Child; use parent 'Base'; sub run { Child->render() }" });
  try {
    await f.build(); const graph = f.graph();
    assert.deepEqual(semanticEdges(graph), ["lib/Child.pm#Child::run -> lib/Base.pm#Base::render [extracted]"]);
    assert.ok(semanticEdges(graph, "extends").includes("lib/Child.pm#Child -> lib/Base.pm#Base [extracted]"));
    assert.ok(semanticEdges(graph, "imports").includes("lib/Child.pm -> lib/Base.pm [extracted]"));
    assert.equal(graph.nodes.find((n) => n.id === "lib/Base.pm#Base::render")!.kind, "function");
    assert.deepEqual(checkGraphInvariants(graph).problems, []);
  } finally { f.close(); }
});

test("inferred parent roots remain inferred through inherited dispatch", async () => {
  const f = perlRepo({ "lib/Base.pm": "package Base; sub render {}", "lib/Child.pm": "package Child; use parent 'Base'; sub run { Child->render() }" }, null);
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["lib/Child.pm#Child::run -> lib/Base.pm#Base::render [inferred]"]);
    assert.ok(semanticEdges(f.graph(), "extends").includes("lib/Child.pm#Child -> lib/Base.pm#Base [inferred]"));
  } finally { f.close(); }
});

test("no-require parents need an explicit reachable declaration and cannot borrow unrelated files", async () => {
  const f = perlRepo({ "lib/Base.pm": "package Base; sub render {}", "child.pm": "package Child; use parent -norequire, 'Base'; sub run { Child->render() }" });
  try {
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), []);
    f.write("child.pm", "package Base; sub render {} package Child; use parent -norequire, 'Base'; sub run { Child->render() }");
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["child.pm#Child::run -> child.pm#Base::render [extracted]"]);
  } finally { f.close(); }
});

test("DFS and C3 use different complete ordered linearizations for a diamond", async () => {
  const base = "package A; sub render {} package B; our @ISA = qw(A); package C; our @ISA = qw(A); sub render {} package D; our @ISA = qw(B C); ";
  const f = perlRepo({ "diamond.pm": base + "sub run { D->render() }" });
  try {
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["diamond.pm#D::run -> diamond.pm#A::render [extracted]"]);
    f.write("diamond.pm", base + "use mro 'c3'; sub run { D->render() }");
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["diamond.pm#D::run -> diamond.pm#C::render [extracted]"]);
    const warm = f.bytes(); await f.build(false); assert.equal(f.bytes(), warm);
  } finally { f.close(); }
});

test("ISA replacement, push and repeated parent declarations preserve language order", async () => {
  const base = "package A; sub render {} package B; sub render {} package C; ";
  const f = perlRepo({ "order.pm": base + "our @ISA = qw(A); @ISA = qw(B); sub run { C->render() }" });
  try {
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["order.pm#C::run -> order.pm#B::render [extracted]"]);
    f.write("order.pm", base + "our @ISA = qw(A); push @ISA, 'B'; sub run { C->render() }");
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["order.pm#C::run -> order.pm#A::render [extracted]"]);
    f.write("order.pm", base + "use parent -norequire, 'A'; use parent -norequire, 'B'; sub run { C->render() }");
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["order.pm#C::run -> order.pm#A::render [extracted]"]);
  } finally { f.close(); }
});

test("SUPER starts from the lexical package's parents, even inside an explicitly qualified sub declaration", async () => {
  const f = perlRepo({ "super.pm": "package Base; sub render {} package OtherBase; sub render {} package Other; our @ISA = qw(OtherBase); package Child; our @ISA = qw(Base); sub render {} sub Other::run { $self->SUPER::render() } sub direct { Child->render() }" });
  try {
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["super.pm#Child::direct -> super.pm#Child::render [extracted]", "super.pm#Other::run -> super.pm#Base::render [extracted]"]);
  } finally { f.close(); }
});

test("bounded lexical bless evidence is inferred, and self spelling or new calls cannot invent receiver types", async () => {
  const f = perlRepo({ "receiver.pm": "package P; sub render {} sub new {} sub bounded { my $obj = bless {}, 'P'; $obj->render() } sub spelling { my ($self) = @_; $self->render() } sub constructor { my $obj = P->new(); $obj->render() }" });
  try {
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["receiver.pm#P::bounded -> receiver.pm#P::render [inferred]", "receiver.pm#P::constructor -> receiver.pm#P::new [extracted]"]);
  } finally { f.close(); }
});

test("receiver assignment, escape and reblessing invalidate an earlier bounded receiver", async () => {
  for (const change of ["$obj = another();", "escape($obj);", "bless $obj, 'Other';"]) {
    const f = perlRepo({ "receiver.pm": `package P; sub render {} package Other; sub render {} package P; sub run { my $obj = bless {}, 'P'; ${change} $obj->render() }` });
    try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), [], change); }
    finally { f.close(); }
  }
});

test("incomplete, cyclic, inconsistent and mutated hierarchies never guess an inherited method", async () => {
  for (const hierarchy of [
    "package A; sub render {} package C; our @ISA = qw(Missing A);",
    "package A; our @ISA = qw(C); sub render {} package C; our @ISA = qw(A);",
    "package A; sub render {} package B; package X; our @ISA = qw(A B); package Y; our @ISA = qw(B A); package C; our @ISA = qw(X Y); use mro 'c3';",
    "package A; sub render {} package C; our @ISA = parents();",
    "package A; sub render {} package C; our @ISA = qw(A); $ISA[0] = choose();",
  ]) {
    const f = perlRepo({ "hierarchy.pm": hierarchy + " sub run { C->render() }" });
    try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), [], hierarchy); }
    finally { f.close(); }
  }
});

test("ordinary direct methods remain resolvable despite an unsupported parent, but inherited ones do not", async () => {
  const f = perlRepo({ "own.pm": "package C; our @ISA = qw(External); sub render {} sub run { C->render(); C->missing() }" });
  try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["own.pm#C::run -> own.pm#C::render [extracted]"]); }
  finally { f.close(); }
});

test("method syntax cannot be captured by a same-named lexical sub and explicit method qualification chooses its package", async () => {
  const f = perlRepo({ "qualified.pm": "package Base; sub render {} package Child; our @ISA = qw(Base); sub render {} sub run { my sub render {} Child->render(); Child->Base::render(); }" });
  try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["qualified.pm#Child::run -> qualified.pm#Base::render [extracted]", "qualified.pm#Child::run -> qualified.pm#Child::render [extracted]"]); }
  finally { f.close(); }
});

test("base tolerates a missing module when an earlier source package exists; a local parent shim disables the adapter", async () => {
  const f = perlRepo({ "base.pm": "package Base; sub render {} package Child; use base 'Base'; sub run { Child->render() }" });
  try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["base.pm#Child::run -> base.pm#Base::render [extracted]"]); }
  finally { f.close(); }
  const shadowed = perlRepo({ "lib/parent.pm": "package parent; sub import {}", "lib/Base.pm": "package Base; sub render {}", "child.pm": "package Child; use parent 'Base'; sub run { Child->render() }" });
  try { await shadowed.build(); assert.deepEqual(semanticEdges(shadowed.graph()), []); }
  finally { shadowed.close(); }
});

test("alias escape and an overridden bless do not retain a inferred receiver", async () => {
  for (const source of ["package P; sub render {} sub run { my $obj = bless {}, 'P'; my $alias = $obj; bless $alias, 'Other'; $obj->render() }", "package P; sub render {} sub bless {} use subs qw(bless); sub run { my $obj = bless {}, 'P'; $obj->render() }"]) {
    const f = perlRepo({ "escape.pm": source });
    try { await f.build(); assert.ok(!f.graph().edges.some((e) => e.relation === "calls" && e.target.endsWith("::render"))); }
    finally { f.close(); }
  }
});

test("core method and ADJUST self evidence is bounded and creates no generated constructor", async () => {
  const f = perlRepo({ "class.pm": "use feature 'class'; class Counter { field $value :param = 0; method render { $value } method run { $self->render() } ADJUST { $self->render() } } Counter->new();" });
  try {
    await f.build(); const graph = f.graph();
    assert.deepEqual(semanticEdges(graph), ["class.pm#Counter::ADJUST -> class.pm#Counter::render [inferred]", "class.pm#Counter::run -> class.pm#Counter::render [inferred]"]);
    assert.ok(!graph.nodes.some((n) => n.name === "new"));
    assert.equal(graph.nodes.find((n) => n.id === "class.pm#Counter")!.kind, "class");
    assert.equal(graph.nodes.find((n) => n.id === "class.pm#Counter::$value")!.kind, "variable");
  } finally { f.close(); }
});
