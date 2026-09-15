import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { perlRepo, semanticEdges, utilSource, runnerSource } from "./helpers/perl-repo.js";
import { checkGraph } from "../src/graph/check.js";
import { extractCachePath } from "../src/graph/extract-cache.js";

const provider = (name = "M", prelude = "use Exporter 'import';", tables = "our @EXPORT_OK = qw(work);") => `package ${name}; ${prelude} ${tables} sub work {} sub defaulted {} sub hidden {} 1;`;
const callsFrom = (f: ReturnType<typeof perlRepo>, file = "main.pl") => f.graph().edges.filter((e) => e.relation === "calls" && e.source.startsWith(file)).map((e) => e.target).sort();
const diagnostics = (f: ReturnType<typeof perlRepo>) => JSON.parse(readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8"));

test("complete supported Perl builds check clean; resolution limitations survive warm reuse without polluting extraction facts", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "main.pl": runnerSource });
  try {
    const complete = await f.build(); assert.deepEqual(complete.errors, []); assert.equal(complete.perl?.partial, 0);
    assert.equal((await checkGraph(f.root, { contextDir: f.out })).ok, true);
    f.write("main.pl", "use Acme::Util (); sub run { normalize('X') }");
    const partial = await f.build(); assert.equal(partial.perl?.partial, 1);
    const coldDiagnostics = diagnostics(f), bytes = f.bytes();
    const checked = await checkGraph(f.root, { contextDir: f.out });
    assert.equal(checked.ok, false); assert.ok(checked.errors?.some((e) => e.includes("PERL_TARGET_UNRESOLVED"))); assert.equal(f.bytes(), bytes);
    const warm = await f.build(); assert.equal(warm.parsed, 0); assert.equal(warm.perl?.workerStarts, 0); assert.deepEqual(warm.errors, partial.errors); assert.deepEqual(diagnostics(f), coldDiagnostics);
    const cache = JSON.parse(readFileSync(extractCachePath(f.out)!, "utf8"));
    assert.deepEqual(cache.files["main.pl"].languageData.diagnostics, [], "repository diagnostics are recomputed, not cached as source facts");
  } finally { f.close(); }
});

test("F04: unmerged distribution contexts select their own modules without executing markers", async () => {
  for (const marker of ["Makefile.PL", "Build.PL", "cpanfile", "META.json"]) {
    const files: Record<string, string> = {};
    for (const service of ["a", "b"]) {
      files[`services/${service}/${marker}`] = marker === "META.json" ? '{"name":"test"}' : "open my $fh, '>', 'never-execute'; print $fh 'bad';";
      files[`services/${service}/lib/Acme/Util.pm`] = utilSource.replace("normalize_sentinel_409", `service_${service}_sentinel`);
      files[`services/${service}/bin/runner.pl`] = runnerSource;
    }
    const f = perlRepo(files, null);
    try {
      await f.build();
      for (const service of ["a", "b"]) assert.ok(semanticEdges(f.graph()).includes(`services/${service}/bin/runner.pl#main::run -> services/${service}/lib/Acme/Util.pm#Acme::Util::normalize [inferred]`));
      assert.equal(f.graph().meta.scopes?.length, 1, "small ranking scopes are merged independently");
      assert.equal(existsSync(join(f.root, "never-execute")), false);
    } finally { f.close(); }
  }
});

test("explicit root order disambiguates duplicate modules; inferred layout cannot choose alphabetically", async () => {
  const f = perlRepo({ "one/M.pm": provider(), "two/M.pm": provider(), "main.pl": "use M qw(work); sub run { work() }" }, null);
  try {
    await f.build(); assert.deepEqual(callsFrom(f), []);
    for (const roots of [["two", "one"], ["one", "two"]]) {
      f.write("graft.perl.json", JSON.stringify({ version: 1, projects: [{ root: ".", analysisCwd: ".", includeRoots: roots }] }));
      const warm = await f.build();
      assert.equal(warm.parsed, 0, "root edits rerun resolution without source parsing");
      assert.deepEqual(callsFrom(f), [`${roots[0]}/M.pm#M::work`]);
      const bytes = f.bytes(); await f.build(false); assert.equal(f.bytes(), bytes);
    }
  } finally { f.close(); }
});

test("literal file loads use analysis CWD and INC semantics, not the caller directory", async () => {
  const f = perlRepo({ "legacy.pl": "sub helper {}", "bin/legacy.pl": "sub helper {}", "bin/run.pl": "require './legacy.pl'; sub run { helper() }", "lib/M.pm": provider(), "quoted.pl": "require 'M.pm'; sub run { M::work() }" });
  try {
    await f.build();
    assert.deepEqual(callsFrom(f, "bin/run.pl"), ["legacy.pl#main::helper"]);
    assert.deepEqual(callsFrom(f, "quoted.pl"), ["lib/M.pm#M::work"]);
    f.write("graft.perl.json", JSON.stringify({ version: 1, projects: [{ root: ".", includeRoots: ["lib"] }] }));
    await f.build(); assert.deepEqual(callsFrom(f, "bin/run.pl"), []);
  } finally { f.close(); }
});

test("module filename and declared package identity remain separate", async () => {
  const f = perlRepo({ "lib/M.pm": provider("Different"), "main.pl": "use M (); sub run { M::work(); Different::work() }" });
  try { await f.build(); assert.deepEqual(callsFrom(f), ["lib/M.pm#Different::work"]); }
  finally { f.close(); }
});

test("standard Exporter default, optional, tag, exclusion and empty imports have exact bindings", async () => {
  const table = "our @EXPORT = qw(defaulted); our @EXPORT_OK = qw(work); our %EXPORT_TAGS = (both => [qw(defaulted work)]);";
  for (const [args, expected] of [["", ["defaulted"]], ["qw(work)", ["work"]], ["qw(:both)", ["defaulted", "work"]], ["qw(:both !defaulted)", ["work"]], ["qw(!defaulted work)", ["work"]], ["()", []]] as const) {
    const f = perlRepo({ "lib/M.pm": provider("M", "use Exporter 'import';", table), "main.pl": `use M ${args}; sub run { work(); defaulted(); hidden() }` });
    try { await f.build(); assert.deepEqual(callsFrom(f), expected.map((name) => `lib/M.pm#M::${name}`).sort(), args); }
    finally { f.close(); }
  }
});

test("Exporter inheritance is recognized; custom import and tag-only membership never prove aliases", async () => {
  for (const prelude of ["use parent 'Exporter';", "use base 'Exporter';", "require Exporter; our @ISA = qw(Exporter);"]) {
    const f = perlRepo({ "lib/M.pm": provider("M", prelude), "main.pl": "use M qw(work); sub run { work() }" });
    try { await f.build(); assert.deepEqual(callsFrom(f), ["lib/M.pm#M::work"]); }
    finally { f.close(); }
  }
  for (const source of [provider() + " sub import {}", provider("M", "use Exporter 'import';", "our %EXPORT_TAGS = (only => [qw(work)]);"), provider("M", "use Exporter 'import';", "our @EXPORT_OK = choose();")]) {
    const f = perlRepo({ "lib/M.pm": source, "main.pl": "use M qw(work); sub run { work() }" });
    try { await f.build(); assert.deepEqual(callsFrom(f), []); assert.equal(f.graph().nodes.find((n) => n.id === "lib/M.pm#M::work")!.exported, false); }
    finally { f.close(); }
  }
});

test("partial export table mutations and deferred assignments cannot establish imported names", async () => {
  for (const tables of ["our @EXPORT_OK = qw(work); $EXPORT_OK[0] = 'hidden';", "sub configure { our @EXPORT_OK = qw(work); }", "our @EXPORT_OK = qw(work); our @EXPORT_FAIL = qw(work);"]) {
    const f = perlRepo({ "lib/M.pm": provider("M", "use Exporter 'import';", tables), "main.pl": "use M qw(work); sub run { work() }" });
    try { await f.build(); assert.deepEqual(callsFrom(f), [], tables); }
    finally { f.close(); }
  }
});

test("replacing EXPORT_TAGS clears earlier tags, including an empty assignment", async () => {
  for (const replace of ["(new => [qw(work)])", "()"]) {
    const f = perlRepo({ "lib/M.pm": provider("M", "use Exporter 'import';", `our @EXPORT_OK = qw(work); our %EXPORT_TAGS = (old => [qw(work)]); %EXPORT_TAGS = ${replace};`), "main.pl": "use M qw(:old); sub run { work() }" });
    try { await f.build(); assert.deepEqual(callsFrom(f), []); }
    finally { f.close(); }
  }
});

test("re-export chains retain weakest provenance and recompute when only a provider changes", async () => {
  const f = perlRepo({ "lib/M.pm": provider(), "lib/Wrapper.pm": "package Wrapper; use M qw(work); use Exporter 'import'; our @EXPORT_OK = qw(work);", "main.pl": "use Wrapper qw(work); sub run { work() }" }, null);
  try {
    await f.build(); assert.ok(semanticEdges(f.graph()).includes("main.pl#main::run -> lib/M.pm#M::work [inferred]"));
    f.write("lib/M.pm", provider("M", "use Exporter 'import';", "our @EXPORT_OK = qw(hidden);"));
    const warm = await f.build(); assert.equal(warm.parsed, 1); assert.deepEqual(callsFrom(f), []);
    const bytes = f.bytes(); await f.build(false); assert.equal(f.bytes(), bytes);
  } finally { f.close(); }
});

test("no/unimport invalidates imported aliases and computed argument lists are not empty imports", async () => {
  for (const load of ["use M qw(work); no M;", "use M import_list();"]) {
    const f = perlRepo({ "lib/M.pm": provider(), "main.pl": `${load} sub run { work() }` });
    try { await f.build(); assert.deepEqual(callsFrom(f), []); }
    finally { f.close(); }
  }
});

test("use lib in a loaded module changes the caller's subsequent search path process-wide", async () => {
  const f = perlRepo({ "lib/Setup.pm": "package Setup; use lib 'extra'; 1;", "extra/M.pm": provider(), "lib/M.pm": provider(), "main.pl": "use Setup (); use M qw(work); sub run { work() }" });
  try { await f.build(); assert.deepEqual(callsFrom(f), ["extra/M.pm#M::work"]); }
  finally { f.close(); }
});

test("unknown cross-module lib effects prevent an exact subsequent load", async () => {
  const f = perlRepo({ "lib/Setup.pm": "package Setup; use lib path_for_runtime(); 1;", "lib/M.pm": provider(), "main.pl": "use Setup (); use M qw(work); sub run { work() }" });
  try {
    await f.build(); assert.deepEqual(callsFrom(f), []);
    assert.ok(diagnostics(f).files["main.pl"].diagnostics.some((d: { code: string }) => d.code === "PERL_MODULE_UNRESOLVED"));
  } finally { f.close(); }
});

test("declaring uncalled mutators does not execute them while loading a module", async () => {
  const f = perlRepo({
    "lib/Setup.pm": "package Setup; sub configure { eval $source; chdir 'extra'; @INC = paths(); } 1;",
    "lib/M.pm": provider(),
    "main.pl": "use Setup (); use M qw(work); sub run { work() }",
  });
  try {
    await f.build(); assert.deepEqual(callsFrom(f), ["lib/M.pm#M::work"]);
    const bytes = f.bytes(), cold = diagnostics(f);
    const warm = await f.build(); assert.equal(warm.parsed, 0); assert.equal(warm.perl?.workerStarts, 0);
    assert.equal(f.bytes(), bytes); assert.deepEqual(diagnostics(f), cold);
    f.write("lib/Setup.pm", "package Setup; sub configure { eval $source; } configure(); 1;");
    const changed = await f.build(); assert.equal(changed.parsed, 1); assert.deepEqual(callsFrom(f), []);
  } finally { f.close(); }
});

test("called routines, transitive calls and callback invocation invalidate initialization load state", async () => {
  for (const initializer of [
    "configure();",
    "sub initialize { configure() } initialize();",
    "BEGIN { configure() }",
    "configure() if $flag;",
    "my $cb = sub { configure() }; $cb->();",
    "my $cb = sub { configure() }; invoke($cb);",
    "invoke(sub { configure() });",
    "invoke(\\&configure);",
    "my sub private { configure() } invoke(\\&private);",
    "*alias = \\&configure; alias();",
    "*{$name} = \\&configure; alias();",
    "sub install { *{$name} = \\&configure; } install(); alias();",
    "sub AUTOLOAD { configure() } missing();",
    "sub AUTOLOAD { configure() } Setup->missing();",
    "$callback->();",
    "sub recurse { recurse(); configure() } recurse();",
  ]) {
    const f = perlRepo({ "lib/Setup.pm": `package Setup; sub configure { eval $source; } ${initializer} 1;`, "lib/M.pm": provider(), "main.pl": "use Setup (); use M qw(work); sub run { work() }" });
    try { await f.build(); assert.deepEqual(callsFrom(f), [], initializer); }
    finally { f.close(); }
  }
});

test("calls into a loaded module and executed import hooks propagate their possible effects", async () => {
  for (const setup of [
    "use Setup (); BEGIN { Setup::configure() }",
    "use Setup qw(configure); BEGIN { configure() }",
    "use Setup (); BEGIN { Setup->configure() }",
    "use Setup;",
    "use Setup (); use Setup;",
    "use Setup (); no Setup;",
  ]) {
    const f = perlRepo({
      "lib/Setup.pm": `package Setup; use Exporter 'import'; our @EXPORT_OK = qw(configure); sub configure { eval $source; } ${setup.includes("BEGIN") ? "" : "sub import { configure() } sub unimport { configure() }"} 1;`,
      "lib/M.pm": provider(), "main.pl": `${setup} use M qw(work); sub run { work() }`,
    });
    try { await f.build(); assert.ok(!callsFrom(f).includes("lib/M.pm#M::work"), setup); }
    finally { f.close(); }
  }
});

test("require and explicit empty use/no do not invoke an importer; inherited import hooks do execute", async () => {
  const files = {
    "lib/Base.pm": "package Base; sub import { eval $source; } sub unimport { eval $source; } 1;",
    "lib/Setup.pm": "package Setup; use parent 'Base'; 1;", "lib/M.pm": provider(),
  };
  for (const [setup, expected] of [
    ["use Setup (); no Setup ();", true],
    ["BEGIN { require Setup; }", true],
    ["use Setup;", false],
  ] as const) {
    const f = perlRepo({ ...files, "main.pl": `${setup} use M qw(work); sub run { work() }` });
    try { await f.build(); assert.equal(callsFrom(f).includes("lib/M.pm#M::work"), expected, setup); }
    finally { f.close(); }
  }
});

test("deferred load observations preserve mutation uncertainty without leaking it into module initialization", async () => {
  const f = perlRepo({
    "lib/Setup.pm": "package Setup; sub configure { chdir 'extra'; require './helper.pl'; } 1;",
    "helper.pl": "sub helper {}", "lib/M.pm": provider(),
    "main.pl": "use Setup (); use M qw(work); sub run { work() }",
  });
  try {
    await f.build(); assert.deepEqual(callsFrom(f), ["lib/M.pm#M::work"]);
    assert.ok(!semanticEdges(f.graph(), "imports").some((edge) => edge === "lib/Setup.pm -> helper.pl [extracted]"));
    f.write("lib/Setup.pm", "package Setup; sub initialize { require './helper.pl'; } initialize(); 1;");
    f.write("helper.pl", "eval $source;");
    await f.build(); assert.deepEqual(callsFrom(f), [], "an actually called deferred loader may execute module effects");
    f.write("lib/Setup.pm", `package Setup; sub initialize { require '${f.root.replaceAll("\\", "/")}/helper.pl'; } initialize(); 1;`);
    await f.build(); assert.deepEqual(callsFrom(f), [], "absolute source loads also carry their possible effects");
  } finally { f.close(); }
});

test("UNITCHECK runs for its module while CHECK and INIT effects wait for program runtime", async () => {
  for (const phase of ["UNITCHECK", "CHECK", "INIT", "END"]) {
    const f = perlRepo({ "lib/Setup.pm": `package Setup; sub configure { eval $source; } ${phase} { configure() } 1;`, "lib/M.pm": provider(), "main.pl": "use Setup (); use M (); sub run { M::work() }" });
    try {
      await f.build();
      assert.equal(f.graph().edges.some((edge) => edge.relation === "imports" && edge.source === "main.pl" && edge.target === "lib/M.pm"), phase !== "UNITCHECK", `${phase} during use`);
      // CHECK/INIT leave the earlier compile-time load provable, but their
      // activated eval still invalidates the later runtime package call.
      assert.equal(callsFrom(f).includes("lib/M.pm#M::work"), phase === "END", `${phase} before runtime call`);
      f.write("main.pl", "use Setup (); require M; sub run { M::work() }");
      await f.build(); assert.equal(callsFrom(f).includes("lib/M.pm#M::work"), phase === "END", `${phase} before runtime require`);
    } finally { f.close(); }
  }
  const f = perlRepo({ "lib/Setup.pm": "package Setup; UNITCHECK { @INC = ('first'); } UNITCHECK { @INC = ('second'); } 1;", "first/M.pm": provider(), "second/M.pm": provider(), "main.pl": "use Setup (); use M qw(work); sub run { work() }" });
  try { await f.build(); assert.deepEqual(callsFrom(f), ["first/M.pm#M::work"], "UNITCHECK blocks execute in reverse definition order"); }
  finally { f.close(); }
});

test("builtin operations do not invoke same-named source mutators without override evidence", async () => {
  for (const [invocation, expected] of [["pop @items;", true], ["&pop();", false], ["use subs qw(pop); pop @items;", false]] as const) {
    const f = perlRepo({ "lib/Setup.pm": `package Setup; sub pop { eval $source; } ${invocation} 1;`, "lib/M.pm": provider(), "main.pl": "use Setup (); use M qw(work); sub run { work() }" });
    try { await f.build(); assert.equal(callsFrom(f).includes("lib/M.pm#M::work"), expected, invocation); }
    finally { f.close(); }
  }
});

test("possible call effects respect project boundaries and explicit shared include roots", async () => {
  const f = perlRepo({
    "a/main.pl": "use Setup (); BEGIN { Setup::configure() } use M qw(work); sub run { work() }",
    "a/lib/M.pm": provider(), "b/lib/Setup.pm": "package Setup; sub configure { eval $source; } 1;",
  }, null);
  const config = (shared: boolean) => JSON.stringify({ version: 1, projects: [
    { root: "a", analysisCwd: "a", includeRoots: shared ? ["b/lib", "a/lib"] : ["a/lib"] },
    { root: "b", analysisCwd: "b", includeRoots: ["b/lib"] },
  ] });
  try {
    f.write("graft.perl.json", config(false));
    await f.build(); assert.ok(callsFrom(f, "a/main.pl").includes("a/lib/M.pm#M::work"), "an isolated same-named mutator is not callable");
    f.write("graft.perl.json", config(true));
    const shared = await f.build(); assert.equal(shared.parsed, 0);
    assert.ok(!callsFrom(f, "a/main.pl").includes("a/lib/M.pm#M::work"), "explicit roots make the other distribution's effects relevant");
    f.write("a/main.pl", "use Setup (); use M qw(work); sub run { work() }");
    await f.build(); assert.ok(callsFrom(f, "a/main.pl").includes("a/lib/M.pm#M::work"), "the shared module's uncalled routine remains deferred");
  } finally { f.close(); }
});

test("compile-time use executes under false runtime conditions; runtime require does not", async () => {
  const f = perlRepo({ "lib/M.pm": provider(), "main.pl": "if (0) { use M qw(work); } sub run { work() }" });
  try {
    await f.build(); assert.deepEqual(callsFrom(f), ["lib/M.pm#M::work"]);
    f.write("main.pl", "if (0) { require M; } sub run { M::work() }");
    await f.build(); assert.deepEqual(callsFrom(f), []);
    f.write("main.pl", "sub run { require M; M::work() } sub outside { M::work() }");
    await f.build(); assert.deepEqual(semanticEdges(f.graph()), ["main.pl#main::run -> lib/M.pm#M::work [extracted]"]);
  } finally { f.close(); }
});

test("short-circuit requires do not establish unconditional reachability", async () => {
  for (const load of ["$flag && require M;", "$flag and require M;", "require M if $flag;", "$flag || require M;"]) {
    const f = perlRepo({ "lib/M.pm": provider(), "main.pl": `${load} sub run { M::work() }` });
    try { await f.build(); assert.deepEqual(callsFrom(f), [], load); }
    finally { f.close(); }
  }
});

test("chdir invalidates CWD-relative file loads; prior cached loads survive ordinary INC path changes", async () => {
  const f = perlRepo({ "helper.pl": "sub helper {}", "bin/helper.pl": "sub helper {}", "main.pl": "chdir 'bin'; require './helper.pl'; sub run { helper() }" });
  try {
    await f.build(); assert.deepEqual(callsFrom(f), []);
    f.write("main.pl", "sub run { chdir 'bin'; require './helper.pl'; helper() }");
    await f.build(); assert.deepEqual(callsFrom(f), []);
  }
  finally { f.close(); }
});

test("BEGIN effects follow compilation order and require respects previously loaded INC entries", async () => {
  const f = perlRepo({ "extra/M.pm": provider(), "lib/M.pm": provider(), "main.pl": "BEGIN { unshift @INC, 'extra'; } use M qw(work); sub run { work() }" });
  try {
    await f.build(); assert.deepEqual(callsFrom(f), ["extra/M.pm#M::work"]);
    f.write("main.pl", "use M (); use lib 'extra'; require M; sub run { M::work() }");
    await f.build(); assert.deepEqual(callsFrom(f), ["lib/M.pm#M::work"]);
    f.write("main.pl", "unshift @INC, 'extra'; use M (); sub run { M::work() }");
    await f.build(); assert.deepEqual(callsFrom(f), ["lib/M.pm#M::work"], "use precedes top-level runtime effects");
  } finally { f.close(); }
});

test("literal INC replacement, append, prepend and removal preserve order", async () => {
  const f = perlRepo({ "first/M.pm": provider(), "second/M.pm": provider(), "main.pl": "BEGIN { @INC = ('first', 'second'); } no lib 'first'; use M qw(work); sub run { work() }" });
  try {
    await f.build(); assert.deepEqual(callsFrom(f), ["second/M.pm#M::work"]);
    f.write("main.pl", "BEGIN { @INC = (); push @INC, 'second', 'first'; } use M qw(work); sub run { work() }");
    await f.build(); assert.deepEqual(callsFrom(f), ["second/M.pm#M::work"]);
  } finally { f.close(); }
});

test("conditional and computed INC mutations never leave a falsely exact module choice", async () => {
  for (const change of ["BEGIN { if ($flag) { unshift @INC, 'extra'; } }", "BEGIN { $INC[0] = path(); }", "BEGIN { @INC = paths(); }", "BEGIN { delete $INC{'M.pm'}; }"]) {
    const f = perlRepo({ "lib/M.pm": provider(), "main.pl": `${change} use M qw(work); sub run { work() }` });
    try { await f.build(); assert.deepEqual(callsFrom(f), [], change); }
    finally { f.close(); }
  }
});

test("a lexical INC variable does not alter the process-wide path", async () => {
  const f = perlRepo({ "lib/M.pm": provider(), "main.pl": "BEGIN { my @INC; @INC = paths(); } use M qw(work); sub run { work() }" });
  try { await f.build(); assert.deepEqual(callsFrom(f), ["lib/M.pm#M::work"]); }
  finally { f.close(); }
});

test("load cycles are bounded and conflicting entry contexts remain unresolved", async () => {
  const f = perlRepo({ "lib/A.pm": "package A; use B (); use M qw(work); sub run { work() }", "lib/B.pm": "package B; use A ();", "lib/M.pm": provider(), "extra/M.pm": provider(), "main.pl": "use lib 'extra'; use A ();" });
  try {
    await f.build(); assert.deepEqual(callsFrom(f, "lib/A.pm"), []);
    assert.ok(diagnostics(f).files["lib/A.pm"].diagnostics.some((d: { code: string }) => d.code === "PERL_MODULE_UNRESOLVED"));
  } finally { f.close(); }
});
