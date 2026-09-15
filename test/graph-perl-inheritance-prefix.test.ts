import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

test("DFS resolves a proven earlier ancestor despite a missing later parent", async () => {
  const f = perlRepo({ "prefix.pl": `package Base; sub run {}
package P; our @ISA = ('Base', 'Missing'); P->run(); P->missing();` });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["prefix.pl -> prefix.pl#Base::run [extracted]"]);
    const diagnostics = JSON.parse(readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8")).files["prefix.pl"].diagnostics;
    assert.ok(diagnostics.some((d: any) => d.code === "PERL_MRO_UNRESOLVED"));
    assert.ok(diagnostics.some((d: any) => d.code === "PERL_TARGET_UNRESOLVED" && d.message.includes("missing")));
    assert.ok(!diagnostics.some((d: any) => d.code === "PERL_TARGET_UNRESOLVED" && d.message.endsWith("run")));
  } finally { f.close(); }
});

test("finite appended parent choices preserve the common earlier ancestor", async () => {
  const f = perlRepo({
    "lib/Base.pm": "package Base; sub run {} 1;",
    "lib/Record.pm": `package Record; use Base (); my $base = 'Cached'; if ($flag) { $base = 'Plain' }
eval "require $base"; our @ISA = ('Base'); push @ISA, $base; 1;`,
    "lib/Cached.pm": "package Cached; sub other {} 1;",
    "lib/Plain.pm": "package Plain; sub other {} 1;",
    "main.pl": "use Record (); Record->run(); Record->other();",
  });
  try {
    await f.build();
    assert.ok(semanticEdges(f.graph()).includes("main.pl -> lib/Base.pm#Base::run [extracted]"));
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes("::other ")));
    const cold = f.bytes();
    assert.equal((await f.build()).parsed, 0);
    assert.equal(f.bytes(), cold);
  } finally { f.close(); }
});

test("prefix lookup never skips an uncertain earlier ancestor or guesses a C3 order", async () => {
  const cases = [
    `package Base; sub run {} package P; our @ISA = ('Missing', 'Base'); P->run();`,
    `package Base; sub run {} package First; our @ISA = ('Missing'); package P; our @ISA = ('First', 'Base'); P->run();`,
    `package Base; sub run {} package P; use mro 'c3'; our @ISA = ('Base', 'Missing'); P->run();`,
    `package Base; sub run {} package P; our @ISA = ('Base'); @ISA = @runtime; P->run();`,
    `package Base; sub run {} package P; our @ISA = ('Base'); unshift @ISA, $runtime; P->run();`,
    `package Base; sub run {} package P; our @ISA = ('Base'); @ISA = ('Missing') if $flag; P->run();`,
    `package Base; sub run {} package P; our @ISA = ('Base', 'P'); P->run();`,
    `package Base; sub run {} package P; our @ISA = ('Base', 'Missing'); *Base::run = sub {}; P->run();`,
  ];
  for (const source of cases) {
    const f = perlRepo({ "unsafe.pl": source });
    try {
      await f.build();
      assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes("#Base::run ")), source);
    } finally { f.close(); }
  }
});

test("an alternative parent's initializer can invalidate an earlier ancestor's method", async () => {
  const f = perlRepo({
    "lib/Base.pm": "package Base; sub run {} 1;",
    "lib/Record.pm": `package Record; use Base (); my $base = 'Cached'; if ($flag) { $base = 'Plain' }
eval "require $base"; our @ISA = ('Base'); push @ISA, $base; 1;`,
    "lib/Cached.pm": "package Cached; 1;",
    "lib/Plain.pm": "package Plain; *Base::run = sub {}; 1;",
    "main.pl": "use Record (); Record->run();",
  });
  try {
    await f.build();
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes(" -> lib/Base.pm#Base::run ")));
  } finally { f.close(); }
});
