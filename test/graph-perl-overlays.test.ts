import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

const diagnostics = (f: ReturnType<typeof perlRepo>) => JSON.parse(readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8")).files;

test("inferred module roots do not confuse a nested base.pm with the core inheritance adapter", async () => {
  const f = perlRepo({
    "lib/RT/URI/base.pm": "package RT::URI::base; use base 'RT::Base';",
    "lib/RT/Base.pm": "package RT::Base; sub work {}",
    "lib/RT/Child.pm": "package RT::Child; use base 'RT::Base'; sub run { RT::Child->work() }",
  }, null);
  try {
    await f.build();
    assert.ok(semanticEdges(f.graph()).includes("lib/RT/Child.pm#RT::Child::run -> lib/RT/Base.pm#RT::Base::work [inferred]"));
    assert.ok(!semanticEdges(f.graph(), "imports").some(edge => edge.startsWith("lib/RT/Child.pm -> lib/RT/URI/base.pm")));
    assert.ok(!JSON.stringify(diagnostics(f)).includes("shadows the standard inheritance adapter"));
  } finally { f.close(); }
});

test("suffix inference needs package evidence but explicit filename resolution allows a different package", async () => {
  const f = perlRepo({ "odd/M.pm": "package Other; sub work {}", "main.pl": "require M; sub run { Other::work() }" }, null);
  try {
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), []);
    f.write("graft.perl.json", JSON.stringify({ version: 1, projects: [{ root: ".", includeRoots: ["odd"] }] }));
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["main.pl#main::run -> odd/M.pm#Other::work [extracted]"]);
  } finally { f.close(); }
});

test("literal eval require records module loads without arbitrary eval mutations", async () => {
  const f = perlRepo({
    "lib/Extra.pm": "package Extra; sub work {} 1;",
    "main.pl": 'eval "require Extra"; eval "require Missing_Local"; sub run { Extra::work() }',
  });
  try {
    await f.build();
    assert.ok(semanticEdges(f.graph(), "imports").some(edge => edge.startsWith("main.pl -> lib/Extra.pm")));
    assert.ok(semanticEdges(f.graph()).some(edge => edge.startsWith("main.pl#main::run -> lib/Extra.pm#Extra::work")));
    assert.ok(!JSON.stringify(diagnostics(f)).includes("PERL_DYNAMIC_EVAL"));
    assert.ok(!JSON.stringify(diagnostics(f)).includes("PERL_INCLUDE_PATH_UNKNOWN"));
    const bytes = f.bytes(), before = diagnostics(f);
    const warm = await f.build(); assert.equal(warm.parsed, 0); assert.equal(f.bytes(), bytes); assert.deepEqual(diagnostics(f), before);
    await f.build(false); assert.equal(f.bytes(), bytes);
  } finally { f.close(); }
});

test("computed eval and literal strings containing more than require stay opaque", async () => {
  for (const expression of ['"require $module"', '"require Extra; arbitrary()"', '$code']) {
    const f = perlRepo({ "lib/Extra.pm": "package Extra; sub work {}", "main.pl": `eval ${expression}; sub run { Extra::work() }` });
    try {
      await f.build(); assert.deepEqual(semanticEdges(f.graph()), []);
      assert.ok(diagnostics(f)["main.pl"].diagnostics.some((d: { code: string }) => d.code === "PERL_DYNAMIC_EVAL"));
    } finally { f.close(); }
  }
});

test("loaded overlays share their package hierarchy and replace earlier implementations", async () => {
  const f = perlRepo({
    "lib/Base.pm": "package Base; sub inherited {} 1;",
    "lib/Thing.pm": 'package Thing; use parent "Base"; sub work {} sub run { Thing->work(); Thing->inherited() } eval "require Thing_Overlay"; eval "require Thing_Local"; 1;',
    "lib/Thing_Overlay.pm": "package Thing; sub work {} sub from_overlay { $self->SUPER::inherited(); Thing->run() } 1;",
    "main.pl": "use Thing (); sub run { Thing->work(); Thing->inherited() }",
  });
  try {
    await f.build();
    const edges = semanticEdges(f.graph());
    for (const edge of [
      "lib/Thing.pm#Thing::run -> lib/Thing_Overlay.pm#Thing::work [inferred]",
      "main.pl#main::run -> lib/Thing_Overlay.pm#Thing::work [inferred]",
      "lib/Thing_Overlay.pm#Thing::from_overlay -> lib/Base.pm#Base::inherited [inferred]",
      "lib/Thing_Overlay.pm#Thing::from_overlay -> lib/Thing.pm#Thing::run [inferred]",
    ]) assert.ok(edges.includes(edge), `${edge}\n${edges.join("\n")}\n${JSON.stringify(diagnostics(f))}`);
    assert.ok(!edges.some(edge => edge.includes(" -> lib/Thing.pm#Thing::work")));
    assert.ok(!JSON.stringify(diagnostics(f)).includes("Conflicting source packages"));
    const bytes = f.bytes(); await f.build(); assert.equal(f.bytes(), bytes); await f.build(false); assert.equal(f.bytes(), bytes);
  } finally { f.close(); }
});

test("overlay replacements follow compile and runtime load order, not filename order", async () => {
  const f = perlRepo({
    "lib/Last.pm": "package P; sub work {} 1;",
    "lib/First.pm": "package P; sub work {} 1;",
    "main.pl": "package P; use Last (); sub work {} require First; sub run { P->work() }",
  });
  try {
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["main.pl#P::run -> lib/First.pm#P::work [extracted]"]);
    f.write("main.pl", "package P; use Last (); use First (); sub work {} sub run { P->work() }");
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["main.pl#P::run -> main.pl#P::work [extracted]"]);
  } finally { f.close(); }
});

test("overlays can change literal inheritance in a known load order", async () => {
  const f = perlRepo({
    "lib/A.pm": "package A; sub work {} 1;", "lib/B.pm": "package B; sub work {} 1;",
    "lib/P.pm": "package P; use parent 'A'; require P_Overlay; sub run { P->work() } 1;",
    "lib/P_Overlay.pm": "package P; use B (); our @ISA = qw(B); 1;",
  });
  try {
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["lib/P.pm#P::run -> lib/B.pm#B::work [extracted]"]);
  } finally { f.close(); }
});

test("conditional and unrelated overlays cannot replace the known package definition", async () => {
  for (const load of ["", "require P_Overlay if flag();", "if (flag()) { require P_Overlay; }"]) {
    const f = perlRepo({ "lib/P.pm": `package P; sub work {} ${load} sub run { P->work() }`, "lib/P_Overlay.pm": "package P; sub work {}" });
    try {
      await f.build(); assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes(" -> lib/P_Overlay.pm#P::work")));
      if (load) assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes(" -> lib/P.pm#P::work")));
    } finally { f.close(); }
  }
});

test("a method called before an overlay loads cannot assume the final replacement", async () => {
  const f = perlRepo({
    "lib/P.pm": "package P; sub work {} sub run { P->work() } run(); require P_Overlay; 1;",
    "lib/P_Overlay.pm": "package P; sub work {} 1;",
  });
  try {
    await f.build(); assert.ok(!semanticEdges(f.graph()).some(edge => edge.startsWith("lib/P.pm#P::run -> ")));
  } finally { f.close(); }
});

test("a loaded overlay's dynamic effects still invalidate affected bindings", async () => {
  const f = perlRepo({
    "lib/P.pm": 'package P; sub work {} eval "require P_Overlay"; sub run { P->work() }',
    "lib/P_Overlay.pm": 'package P; eval $code; 1;',
  });
  try {
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), []);
    assert.ok(JSON.stringify(diagnostics(f)).includes("PERL_DYNAMIC_EVAL"));
  } finally { f.close(); }
});

test("conditional overlays cannot establish or preserve an inherited target", async () => {
  const f = perlRepo({
    "lib/A.pm": "package A; sub work {}", "lib/B.pm": "package B; sub work {}",
    "lib/P.pm": "package P; use parent 'A'; if (flag()) { require P_Overlay; } sub run { P->work() }",
    "lib/P_Overlay.pm": "package P; use B (); our @ISA = qw(B);",
  });
  try { await f.build(); assert.ok(!semanticEdges(f.graph()).some(edge => edge.startsWith("lib/P.pm#P::run -> "))); }
  finally { f.close(); }
});

test("cycles in package initialization leave conflicting definitions unresolved", async () => {
  const f = perlRepo({
    "lib/P.pm": "package P; sub work {} require P_Overlay; sub run { P->work() }",
    "lib/P_Overlay.pm": "package P; sub work {} require P;",
  });
  try { await f.build(); assert.ok(!semanticEdges(f.graph()).some(edge => edge.startsWith("lib/P.pm#P::run -> "))); }
  finally { f.close(); }
});
