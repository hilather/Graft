import { test } from "node:test";
import assert from "node:assert/strict";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

test("bounded routine entries join activated caller, helper, argument and re-entry effects", async () => {
  const cases: [string, string, boolean][] = [
    ["independent", "sub mutate { eval $source } sub run { work() }", true],
    ["other-package-independent", "package Q; sub mutate { eval $source } package P; sub run { work() }", true],
    ["pure-caller", "sub mutate { eval $source } sub run { work() } sub outer { run() }", true],
    ["prior-caller", "sub mutate { eval $source } sub run { work() } sub outer { mutate(); run() }", false],
    ["transitive-caller", "sub mutate { eval $source } sub run { work() } sub middle { run() } sub outer { mutate(); middle() }", false],
    ["prior-helper", "sub mutate { eval $source } sub wrap { mutate() } sub run { wrap(); work() }", false],
    ["cross-package-helper", "package Q; sub mutate { eval $source } package P; sub run { Q::mutate(); work() }", false],
    ["cross-package-init", "package Q; eval $source; package P; sub run { work() }", false],
    ["argument", "sub mutate { eval $source } sub run { work(mutate()) }", false],
    ["callback", "sub run { consume(sub { eval $source }); work() }", false],
    ["named-callback", "sub mutate { eval $source } sub run { consume(\\&mutate); work() }", false],
    ["recursive", "sub mutate { *P::work = sub {} } sub run { work(); mutate(); run() }", false],
    ["mutual-recursion", "sub mutate { *P::work = sub {} } sub run { work(); mutate(); again() } sub again { run() }", false],
    ["callback-reentry", "sub run { work(); *P::work = sub {}; consume(sub { run() }) }", false],
    ["pure-recursion", "sub unused { eval $source } sub run { work(); run() }", true],
    ["loop", "sub run { while ($again) { work(); *P::work = sub {} } }", false],
    ["goto", "sub run { START: work(); *P::work = sub {}; goto START }", false],
    ["simple-block", "sub unused { eval $source } sub run { { work() } }", true],
    ["unknown-reentry", "sub run { work(); eval $source }", false],
    ["helper-unknown-reentry", "sub mutate { eval $source } sub run { work(); mutate() }", false],
    ["dynamic-reentry", "sub run { work(); *P::work = sub {}; $cb->() }", false],
    ["transitive-dynamic-reentry", "sub helper { $cb->() } sub run { work(); *P::work = sub {}; helper() }", false],
    ["enclosing-callee-after-argument", "sub outer { *P::work = sub {} } sub run { outer(work()) }", true],
    ["replaced-named-reentry", "sub invoke {} *invoke = $cb; sub run { work(); *P::work = sub {}; invoke() }", false],
    ["helper-replaced-named-reentry", "sub invoke {} sub replace { *P::invoke = $cb } sub run { work(); *P::work = sub {}; replace(); invoke() }", false],
    ["computed-load-reentry", "sub run { work(); *P::work = sub {}; require $module }", false],
    ["method-slot-reentry", "package Q; sub invoke {} package P; sub run { work(); *P::work = sub {}; *Q::invoke = $cb; Q->invoke() }", false],
    ["replacement-callback-reentry", "sub invoke {} sub run { work(); *P::work = sub {}; *P::invoke = sub { run() }; invoke() }", false],
    ["unrelated-helper-name", "package Q; sub helper { eval $source } package P; sub helper {} sub run { helper(); work() }", true],
  ];
  for (const [label, body, expected] of cases) {
    const f = perlRepo({ "entry.pm": `package P; sub work {} ${body}` });
    try {
      const cold = await f.build(false);
      assert.deepEqual(cold.errors.filter((error) => /PERL_PARSE_ERROR|PERL_WORKER|PERL_PARSE_TIMEOUT/.test(error)), [], label);
      const edge = f.graph().edges.find((edge) => edge.relation === "calls" && edge.source === "entry.pm#P::run" && edge.target === "entry.pm#P::work");
      assert.equal(!!edge, expected, label);
      if (expected) assert.equal(edge?.confidence, "inferred", label);
    } finally { f.close(); }
  }
});

test("straight-line routine calls distinguish before and after known slot mutations", async () => {
  // Distinct targets prevent graph deduplication hiding a bad second-site edge.
  const f = perlRepo({ "entry.pm": "package P; sub first {} sub second {} sub mutate { *P::first = sub {}; *P::second = sub {} } sub run { first(); mutate(); second() }" });
  try {
    await f.build(false);
    const edges = semanticEdges(f.graph());
    assert.ok(edges.includes("entry.pm#P::run -> entry.pm#P::first [inferred]"));
    assert.ok(!edges.some((edge) => edge.includes("P::run -> entry.pm#P::second")));
    const bytes = f.bytes(); const warm = await f.build();
    assert.equal(warm.parsed, 0); assert.equal(warm.perl?.workerStarts, 0); assert.equal(f.bytes(), bytes);
  } finally { f.close(); }
});

test("standard imports capture provider initialization and retain consumer invalidation", async () => {
  const provider = "package Provider; use Exporter 'import'; our @EXPORT_OK = qw(work); sub work {} ";
  const cases: [string, string, string, boolean][] = [
    ["unused-provider-mutator", "sub mutate { eval $source }", "sub run { work() }", true],
    ["provider-initialization", "eval $source;", "sub run { work() }", false],
    ["provider-known-after-capture", "sub mutate { *Provider::work = sub {} }", "sub run { Provider::mutate(); work() }", true],
    ["provider-unknown-after-capture", "sub mutate { eval $source }", "sub run { Provider::mutate(); work() }", false],
    ["consumer-mutation", "", "sub run { *Consumer::work = sub {}; work() }", false],
    ["consumer-eval", "", "sub run { eval $source; work() }", false],
    ["other-package-eval", "", "package Elsewhere; sub mutate { eval $source } package Consumer; sub run { Elsewhere::mutate(); work() }", false],
    ["unused-other-package-mutator", "", "package Elsewhere; sub mutate { eval $source } package Consumer; sub run { work() }", true],
    ["prior-consumer-begin", "", "", false],
  ];
  for (const [label, extra, body, expected] of cases) {
    const before = label === "prior-consumer-begin" ? "use Provider (); BEGIN { *Provider::work = sub {} }" : "";
    const f = perlRepo({ "consumer.pm": `package Consumer; ${before} use Provider qw(work); ${body || "sub run { work() }"}`, "lib/Provider.pm": `${provider} ${extra} 1;` });
    try {
      await f.build(false);
      assert.equal(f.graph().edges.some((edge) => edge.relation === "calls" && edge.source === "consumer.pm#Consumer::run" && edge.target === "lib/Provider.pm#Provider::work"), expected, label);
    } finally { f.close(); }
  }
});

test("an unused loaded mutator is inactive and activating it invalidates cross-file bindings", async () => {
  const f = perlRepo({
    "entry.pm": "package P; use Helper (); sub work {} sub run { work() }",
    "lib/Helper.pm": "package Helper; sub mutate { eval $source } 1;",
  });
  try {
    await f.build(false);
    assert.ok(semanticEdges(f.graph()).includes("entry.pm#P::run -> entry.pm#P::work [inferred]"));
    f.write("entry.pm", "package P; use Helper (); sub work {} sub run { Helper::mutate(); work() }");
    await f.build();
    assert.ok(!semanticEdges(f.graph()).some((edge) => edge.includes("P::run -> entry.pm#P::work")));
    const bytes = f.bytes(); await f.build(false); assert.equal(f.bytes(), bytes);
  } finally { f.close(); }
});

test("escaped callback identities retain incoming caller effects", async () => {
  const f = perlRepo({ "entry.pm": "package P; sub work {} my $cb = sub { work() }; sub outer { *P::work = sub {}; consume($cb) }" });
  try {
    await f.build(false);
    assert.ok(!f.graph().edges.some((edge) => edge.relation === "calls" && edge.target === "entry.pm#P::work"));
  } finally { f.close(); }
});

test("independent scripts sharing a module do not share main invocation histories", async () => {
  const f = perlRepo({
    "a.pl": "use Shared (); sub helper {} sub entry { *main::work = sub {}; helper() }",
    "b.pl": "use Shared (); sub work {} sub helper { work() }",
    "lib/Shared.pm": "package Shared; 1;",
  });
  try {
    await f.build(false);
    assert.ok(f.graph().edges.some((edge) => edge.relation === "calls" && edge.source === "b.pl#main::helper" && edge.target === "b.pl#main::work"));
  } finally { f.close(); }
});

test("reexport capture retains mutations in the loading consumer's context", async () => {
  const f = perlRepo({
    "consumer.pm": "package Consumer; use Provider (); BEGIN { *Provider::work = sub {} } use Facade qw(work); sub run { work() }",
    "lib/Provider.pm": "package Provider; use Exporter 'import'; our @EXPORT_OK = qw(work); sub work {} 1;",
    "lib/Facade.pm": "package Facade; use Exporter 'import'; use Provider qw(work); our @EXPORT_OK = qw(work); 1;",
  });
  try {
    await f.build(false);
    assert.ok(!f.graph().edges.some((edge) => edge.relation === "calls" && edge.source === "consumer.pm#Consumer::run" && edge.target === "lib/Provider.pm#Provider::work"));
  } finally { f.close(); }
});

test("loaded helpers carry caller state back into their importing script", async () => {
  const f = perlRepo({
    "entry.pl": "use Helper (); sub work {} sub run { work() } sub entry { *main::work = sub {}; Helper::invoke() }",
    "lib/Helper.pm": "package Helper; sub invoke { main::run() } 1;",
  });
  try {
    await f.build(false);
    assert.ok(!f.graph().edges.some((edge) => edge.relation === "calls" && edge.source === "entry.pl#main::run" && edge.target === "entry.pl#main::work"));
  } finally { f.close(); }
});

test("transitive compile loads retain scheduled initialization effects", async () => {
  for (const phase of ["CHECK", "INIT"]) {
    const f = perlRepo({
      "entry.pm": "package P; use A (); sub work {} sub run { work() }",
      "lib/A.pm": "package A; use B (); 1;",
      "lib/B.pm": `package B; ${phase} { *P::work = sub {} } 1;`,
    });
    try {
      await f.build(false);
      assert.ok(!f.graph().edges.some((edge) => edge.relation === "calls" && edge.source === "entry.pm#P::run" && edge.target === "entry.pm#P::work"), phase);
    } finally { f.close(); }
  }
});

test("unknown effects in loaded code retain possible caller re-entry", async () => {
  const f = perlRepo({
    "entry.pm": "package P; sub work {} sub run { work(); *P::work = sub {}; require Hook }",
    "lib/Hook.pm": "package Hook; eval $source; 1;",
  });
  try {
    await f.build(false);
    assert.ok(!f.graph().edges.some((edge) => edge.relation === "calls" && edge.source === "entry.pm#P::run" && edge.target === "entry.pm#P::work"));
  } finally { f.close(); }
});

test("module and import callbacks inherit effects preceding their activation", async () => {
  for (const hook of [false, true]) {
    const f = perlRepo({
      "entry.pm": `package P; sub work {} sub run { work() } ${hook ? "BEGIN { *P::work = sub {} } use Hook;" : "sub outer { *P::work = sub {}; require Hook }"}`,
      "lib/Hook.pm": `package Hook; ${hook ? "sub import { P::run() }" : "P::run();"} 1;`,
    });
    try {
      await f.build(false);
      assert.ok(!f.graph().edges.some((edge) => edge.relation === "calls" && edge.source === "entry.pm#P::run" && edge.target === "entry.pm#P::work"), hook ? "import" : "module");
    } finally { f.close(); }
  }
});

test("scheduled lifecycle callbacks inherit the loading consumer's compile-time state", async () => {
  for (const phase of ["CHECK", "INIT"]) {
    const f = perlRepo({
      "main.pl": "use P (); BEGIN { *P::work = sub {} } use Hook ();",
      "lib/P.pm": "package P; sub work {} sub run { work() } 1;",
      "lib/Hook.pm": `package Hook; use P (); ${phase} { P::run() } 1;`,
    });
    try {
      await f.build(false);
      assert.ok(!f.graph().edges.some((edge) => edge.relation === "calls" && edge.source === "lib/P.pm#P::run" && edge.target === "lib/P.pm#P::work"), phase);
    } finally { f.close(); }
  }
});

test("requires reached through BEGIN helpers schedule lifecycle effects without treating ordinary runtime requires as compile time", async () => {
  for (const compile of [true, false]) {
    const f = perlRepo({
      "entry.pm": `package P; sub work {} sub load_hook { require Hook } ${compile ? "BEGIN { load_hook() }" : "load_hook();"} sub run { work() }`,
      "lib/Hook.pm": "package Hook; INIT { *P::work = sub {} } 1;",
    });
    try {
      await f.build(false);
      assert.equal(f.graph().edges.some((edge) => edge.relation === "calls" && edge.source === "entry.pm#P::run" && edge.target === "entry.pm#P::work"), !compile, compile ? "BEGIN activation" : "runtime activation");
    } finally { f.close(); }
  }
});

test("standard imported helpers do not activate unrelated same-named source bodies", async () => {
  const f = perlRepo({
    "entry.pm": "package P; use Helper qw(helper); sub work {} sub run { helper(); work() } package Q; sub helper { eval $source }",
    "lib/Helper.pm": "package Helper; use Exporter 'import'; our @EXPORT_OK = qw(helper); sub helper {} 1;",
  });
  try {
    await f.build(false);
    assert.ok(semanticEdges(f.graph()).includes("entry.pm#P::run -> entry.pm#P::work [inferred]"));
  } finally { f.close(); }
});

test("cross-file replacement of a helper retains replacement callback effects", async () => {
  const f = perlRepo({
    "entry.pm": "package P; use Helper (); sub work {} sub helper {} sub run { Helper::replace(); helper(); work() }",
    "lib/Helper.pm": "package Helper; sub replace { *P::helper = sub { *P::work = sub {} } } 1;",
  });
  try {
    await f.build(false);
    assert.ok(!f.graph().edges.some((edge) => edge.relation === "calls" && edge.source === "entry.pm#P::run" && edge.target === "entry.pm#P::work"));
  } finally { f.close(); }
});
