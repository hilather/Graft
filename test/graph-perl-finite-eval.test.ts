import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PerlParser } from "../src/graph/perl-parser.js";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

test("finite lexical require evals retain alternative module names without unrestricted mutations", async () => {
  const parser = new PerlParser();
  try {
    const result = await parser.extract("record.pm", `package Record;
my $base = 'Parent::Cached';
if ($Config && $Config->Get('NoCache')) { $base = 'Parent::Plain' }
eval "require $base" or die $@;
our @ISA = 'Base'; push @ISA, $base;
sub helper { for (@_) { next unless $_ } $_[0] =~ s/([A-Z])/" " . lc $1/ge }
`);
    assert.notEqual(result.status, "failed");
    const facts = result.languageData;
    assert.deepEqual(facts.loads.map(load => load.target), [
      { kind: "known", value: "Parent::Cached" }, { kind: "known", value: "Parent::Plain" },
    ]);
    assert.ok(facts.loads.every(load => load.conditional && load.trapped));
    assert.equal(facts.mutations.length, 0);
    assert.equal(facts.includeEffects.length, 0);
    assert.ok(!facts.diagnostics.some(d => d.code === "PERL_DYNAMIC_EVAL"));
    assert.deepEqual(facts.inheritance.at(-1)?.parentAlternatives, [["Parent::Cached"], ["Parent::Plain"]]);
  } finally { await parser.dispose(); }
});

test("unknown writes, escaped lexicals, generated code, and uncertain entry order remain dynamic", async () => {
  const parser = new PerlParser();
  const cases = [
    `my $base; eval "require $base";`,
    `our $base = 'A'; eval "require $base";`,
    `state $base = 'A'; eval "require $base";`,
    `my $base = 'A' if $flag; eval "require $base";`,
    `my $base = 'A'; if ($flag) { eval "require $base" }`,
    `my $base = 'A'; sub run { eval "require $base" }`,
    `my $base = 'A'; $base = source(); eval "require $base";`,
    `my $base = 'A'; $base .= 'B'; eval "require $base";`,
    String.raw`my $base = 'A'; capture(\$base); eval "require $base";`,
    `my $base = 'A'; mutate($base); eval "require $base";`,
    `my $base = 'A'; eval $code; eval "require $base";`,
    `my $base = 'A'; callback(); eval "require $base"; sub callback { eval $code }`,
    `my $base = 'A'; callback(); eval "require $base"; sub callback { $base = source() }`,
    String.raw`my $base = 'A'; callback(); eval "require $base"; BEGIN { capture(\$base) }`,
    `my $base = 'A'; { my $base = source(); eval "require $base" }`,
    `my $base = 'A; malicious()'; eval "require $base";`,
    `my $base = 'A'; eval "require $base; malicious()";`,
    `my $base = 'A'; $_ =~ s/a/mutate($base)/e; eval "require $base";`,
    `my $base = 'A'; $_ =~ s/a/$code/ee; eval "require $base";`,
    `my $base = 'A'; $_ =~ s/a/eval $code/e; eval "require $base";`,
    `my $base = 'A'; \${base} = source(); eval "require $base";`,
    `my $base = 'A'; LABEL: eval "require $base"; goto LABEL;`,
    `my $base = 'A'; ${Array.from({ length: 9 }, (_, i) => `$base = 'P${i}' if $flag;`).join(" ")} eval "require $base";`,
  ];
  try {
    for (const source of cases) {
      const result = await parser.extract("unsafe.pl", source);
      assert.notEqual(result.status, "failed", source);
      assert.ok(result.languageData.diagnostics.some(d => d.code === "PERL_DYNAMIC_EVAL"), source);
      assert.ok(result.languageData.mutations.some(m => m.names.kind === "unknown"), source);
    }
  } finally { await parser.dispose(); }
});

test("deferred eval finalization retains the package at each source site", async () => {
  const parser = new PerlParser();
  try {
    const result = await parser.extract("packages.pm", `package First; eval $code;
package Second; my $base = 'Parent'; eval "require $base";
package Third; sub run {}`);
    assert.equal(result.languageData.mutations[0]?.packageName, "First");
    // First's arbitrary eval precedes the declaration, so it cannot name this
    // later lexical. Second's bounded load retains its own package context.
    assert.equal(result.languageData.loads.at(-1)?.packageName, "Second");
    const forward = await parser.extract("forward.pm", "package Third; sub run; sub run { eval $code }");
    const run = forward.languageData.definitions.find(def => def.qualifiedName === "Third::run");
    assert.equal(forward.languageData.mutations.at(-1)?.sourceNode, run?.nodeId);
  } finally { await parser.dispose(); }
});

test("bounded require alternatives preserve subsequent source calls and warm-cache results", async () => {
  const f = perlRepo({
    "main.pl": `my $base = 'A'; if ($flag) { $base = 'B' } eval "require $base"; require Keep; Keep::run();`,
    "lib/A.pm": "package A; 1;", "lib/B.pm": "package B; 1;",
    "lib/Keep.pm": "package Keep; sub run {} 1;",
  });
  try {
    await f.build();
    assert.ok(semanticEdges(f.graph()).includes("main.pl -> lib/Keep.pm#Keep::run [extracted]"));
    assert.ok(!readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8").includes("PERL_DYNAMIC_EVAL"));
    const cold = f.bytes();
    assert.equal((await f.build()).parsed, 0);
    assert.equal(f.bytes(), cold);
  } finally { f.close(); }
});

test("each possible required module contributes its initialization effects", async () => {
  const f = perlRepo({
    "main.pl": `my $base = 'A'; if ($flag) { $base = 'B' } eval "require $base"; require Keep; Keep::run();`,
    "lib/A.pm": "package A; 1;", "lib/B.pm": "package B; @INC = @runtime_paths; 1;",
    "lib/Keep.pm": "package Keep; sub run {} 1;",
  });
  try {
    await f.build();
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes(" -> lib/Keep.pm#Keep::run ")));
    assert.ok(readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8").includes("PERL_INCLUDE_PATH_UNKNOWN"));
  } finally { f.close(); }
});
