import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

const diagnostics = (f: ReturnType<typeof perlRepo>) => JSON.parse(readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8")).files;

test("legacy foreach qw lists preserve loop calls and following declarations", async () => {
  const f = perlRepo({ "legacy.pl": `package Legacy;
sub visit {} sub finish {}
sub run {
  foreach my $date qw(due starts started resolved) { visit($date) }
  foreach my $field
    qw{Creator Created LastUpdated}
  { visit($field) }
  for $Legacy::field qw/name address/ { visit($Legacy::field) }
  finish();
}
sub following { finish() }
` });
  try {
    await f.build();
    assert.ok(!JSON.stringify(diagnostics(f)).includes("PERL_PARSE_ERROR"));
    assert.deepEqual(semanticEdges(f.graph()), [
      "legacy.pl#Legacy::following -> legacy.pl#Legacy::finish [extracted]",
      "legacy.pl#Legacy::run -> legacy.pl#Legacy::finish [extracted]",
      "legacy.pl#Legacy::run -> legacy.pl#Legacy::visit [extracted]",
    ]);
    const before = f.bytes();
    const warm = await f.build();
    assert.equal(warm.parsed, 0);
    assert.equal(f.bytes(), before);
  } finally { f.close(); }
});

test("legacy qw support keeps missing iterators, delimiters, and bodies invalid", async () => {
  for (const source of [
    "foreach qw(a b) { work() }",
    "foreach my $item qw(a b { work() }",
    "foreach my $item qw(a b);",
  ]) {
    const f = perlRepo({ "broken.pl": source });
    try {
      await f.build();
      assert.ok(JSON.stringify(diagnostics(f)).includes("PERL_PARSE_ERROR"), source);
    } finally { f.close(); }
  }
});

test("__PACKAGE__ method receivers follow lexical package scope", async () => {
  const f = perlRepo({ "packages.pl": `package Outer;
sub target {} sub run { __PACKAGE__->target() }
{ package Inner; sub target {} sub run { __PACKAGE__->target() } }
sub again { (__PACKAGE__)->target() }
package Other;
sub target {} sub Foreign::run { __PACKAGE__->target() }
` });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), [
      "packages.pl#Foreign::run -> packages.pl#Other::target [extracted]",
      "packages.pl#Inner::run -> packages.pl#Inner::target [extracted]",
      "packages.pl#Outer::again -> packages.pl#Outer::target [extracted]",
      "packages.pl#Outer::run -> packages.pl#Outer::target [extracted]",
    ]);
    assert.ok(!JSON.stringify(diagnostics(f)).includes("PERL_DYNAMIC_DISPATCH"));
  } finally { f.close(); }
});

test("literal and computed receivers do not acquire the __PACKAGE__ value", async () => {
  const f = perlRepo({ "packages.pl": `package Outer; sub target {}
sub run { "__PACKAGE__"->target(); factory()->target(); }
` });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), []);
    assert.ok(JSON.stringify(diagnostics(f)).includes("PERL_DYNAMIC_DISPATCH"));
  } finally { f.close(); }
});
