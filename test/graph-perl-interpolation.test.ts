import { test } from "node:test";
import assert from "node:assert/strict";
import { PerlParser } from "../src/graph/perl-parser.js";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

async function extract(source: string) {
  const parser = new PerlParser();
  try { return await parser.extract("main.pl", source); }
  finally { await parser.dispose(); }
}

test("string and command interpolation expose only executable expressions", async () => {
  const source = 'package P; sub render { my $x = "literal() @{[first()]} ${\\second()} ${$m.\'::VERSION\'}"; my $y = `shell_literal @{[third()]}`; }';
  const result = await extract(source);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.languageData.calls.map(call => call.name.kind === "known" && call.name.value), ["first", "second", "third"]);
  for (const call of result.languageData.calls) {
    assert.equal(call.sourceNode, "main.pl#P::render");
    assert.equal(call.packageName, "P");
    assert.equal(call.conditional, false);
    assert.ok(source.slice(call.range.start, call.range.end).endsWith("()"));
  }
});

test("pattern interpolation is evaluated before matching and replacement interpolation remains conditional", async () => {
  const source = '$x =~ s{@{[pattern()]}}{@{[replacement()]}}g; my $r = qr/@{[quoted()]}/; $x =~ /@{[matched()]}/; $x =~ s{@{[before()]}}{after()}e;';
  const result = await extract(source);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.languageData.calls.map(call => [call.name.kind === "known" && call.name.value, call.conditional]),
    [["pattern", false], ["replacement", true], ["quoted", false], ["matched", false], ["before", false], ["after", true]]);
});

test("interpolated callback scopes preserve lexical identity and do not duplicate nested calls", async () => {
  const source = 'sub target {} my $cb = \\&target; my $text = "@{[do { my $local = sub { $cb->() }; $local->() }]}"; $local->(); my $nested = "@{[qq{@{[nested()]}}]}";';
  const result = await extract(source);
  const calls = result.languageData.calls;
  const callbacks = calls.filter(call => call.form === "coderef");
  assert.equal(callbacks.length, 3);
  assert.ok(callbacks[0].bindingId);
  assert.ok(callbacks[1].bindingId);
  assert.equal(callbacks[2].bindingId, undefined);
  assert.equal(calls.filter(call => call.name.kind === "known" && call.name.value === "nested").length, 1);
});

test("interpolation mutations affect enclosing call selection and later module loads", async () => {
  for (const symbol of [false, true]) for (const invoked of [false, true]) {
    const expression = invoked ? '@{[change()]}' : 'change()';
    const mutation = symbol ? '*helper = sub {};' : "delete $INC{'Good.pm'};";
    const f = perlRepo({ "main.pl": `sub helper {} sub change { ${mutation} } helper("${expression}"); require Good; Good::run();`,
      "lib/Good.pm": "package Good; sub run {} 1;" });
    try {
      await f.build();
      const edges = semanticEdges(f.graph());
      if (symbol) assert.equal(edges.some(edge => edge === "main.pl -> main.pl#main::helper [extracted]"), !invoked);
      else assert.equal(edges.some(edge => edge.includes("Good::run")), !invoked);
    } finally { f.close(); }
  }
});

test("single quotes and escaped interpolation stay literal; regex code and heredocs retain coverage warnings", async () => {
  const source = "my $a = '@{[fake()]}'; my $b = q{@{[fake()]}}; my $c = qq{\\@{[fake()]}}; my $r = qr/(?{ hidden() })/; my $h = <<EOF;\n@{[deferred_location()]}\nEOF\n";
  const result = await extract(source);
  assert.deepEqual(result.languageData.calls, []);
  assert.equal(result.languageData.diagnostics.filter(d => d.code === "PERL_EMBEDDED_CODE_UNSUPPORTED").length, 2);
});

test("interpolation resolution survives cached builds and provider-only edits", async () => {
  const f = perlRepo({ "main.pl": 'use P (); my $text = "@{[P::render()]}";', "lib/P.pm": "package P; sub render {} 1;" });
  try {
    await f.build();
    assert.ok(semanticEdges(f.graph()).some(edge => edge.includes("P::render")));
    const bytes = f.bytes();
    assert.equal((await f.build()).parsed, 0);
    assert.equal(f.bytes(), bytes);
    f.write("lib/P.pm", "package P; sub replacement {} 1;");
    assert.equal((await f.build()).parsed, 1);
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes("P::render")));
  } finally { f.close(); }
});
