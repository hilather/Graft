import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

const diagnostics = (f: ReturnType<typeof perlRepo>) => JSON.parse(readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8")).files;

test("literal CODE aliases resolve after installation and retain the captured target", async () => {
  const f = perlRepo({ "alias.pl": String.raw`package P;
sub target {}
*first = \&target;
*second = \&first;
*target = sub {};
first(); second();
` });
  try {
    await f.build();
    assert.ok(semanticEdges(f.graph()).includes("alias.pl -> alias.pl#P::target [extracted]"));
    assert.ok(!Object.values(diagnostics(f)).flatMap((entry: any) => entry.diagnostics)
      .some((d: any) => d.code === "PERL_TARGET_UNRESOLVED" && /first|second/.test(d.message)));
    const cold = f.bytes();
    const warm = await f.build();
    assert.equal(warm.parsed, 0);
    assert.equal(f.bytes(), cold);
  } finally { f.close(); }
});

test("a module's literal aliases are callable after a resolved load", async () => {
  const f = perlRepo({
    "lib/P.pm": String.raw`package P; *alias = \&target; sub target {} 1;`,
    "main.pl": "use P (); P::alias(); P->alias();",
  });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["main.pl -> lib/P.pm#P::target [extracted]"]);
    assert.ok(!JSON.stringify(diagnostics(f)).includes("PERL_SYMBOL_TABLE_MUTATION"));
  } finally { f.close(); }
});

test("conditional, deferred, missing, and early alias targets stay unresolved", async () => {
  for (const source of [
    String.raw`package P; sub target {} if ($flag) { *alias = \&target } alias();`,
    String.raw`package P; sub target {} sub install { *alias = \&target } alias();`,
    String.raw`package P; *alias = \&missing; alias();`,
    String.raw`package P; sub target {} alias(); *alias = \&target;`,
    String.raw`package P; sub target {} sub run { alias() } run(); *alias = \&target;`,
    String.raw`package P; sub target {} *alias = \&target; *alias = sub {}; alias();`,
    String.raw`package P; sub target {} *alias = \&target; eval $code; alias();`,
  ]) {
    const f = perlRepo({ "alias.pl": source });
    try {
      await f.build();
      assert.deepEqual(semanticEdges(f.graph()).filter(edge => edge.includes(" -> alias.pl#P::target ")), [], source);
      assert.ok(JSON.stringify(diagnostics(f)).includes("PERL_TARGET_UNRESOLVED"), source);
    } finally { f.close(); }
  }
});

test("alias calls carry the target's module and symbol mutations", async () => {
  const f = perlRepo({ "alias.pl": String.raw`package P;
sub target { eval $code }
sub victim {}
*alias = \&target;
alias(); victim();
` });
  try {
    await f.build();
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes(" -> alias.pl#P::victim ")));
  } finally { f.close(); }
});

test("module initialization can invoke a routine before its alias is installed", async () => {
  const f = perlRepo({
    "main.pl": String.raw`package P; our @ISA = (); sub target {} sub run { alias() } use Trigger (); *alias = \&target;`,
    "lib/Trigger.pm": "package Trigger; P::run(); 1;",
  });
  try {
    await f.build();
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.startsWith("main.pl#P::run ->")));
  } finally { f.close(); }
});
