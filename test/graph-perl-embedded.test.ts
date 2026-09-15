import { test } from "node:test";
import assert from "node:assert/strict";
import { PerlParser } from "../src/graph/perl-parser.js";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

async function extract(source: string) {
  const parser = new PerlParser();
  try { return await parser.extract("main.pl", source); }
  finally { await parser.dispose(); }
}

test("single-e substitutions expose calls with their original source positions", async () => {
  const source = '# Unicode: café 🙂\npackage Example; sub encode {\n  $v =~ s/([^a-z])/sprintf("%02X", ord($1))/ge;\n  $v =~ s (x) # separate delimiters\n    {\n      normalize($1)\n    }e;\n}';
  const result = await extract(source);
  assert.equal(result.status, "ok");
  const calls = result.languageData.calls;
  assert.deepEqual(calls.map(call => call.name.kind === "known" ? call.name.value : "?"), ["sprintf", "ord", "normalize"]);
  for (const call of calls) {
    assert.equal(call.sourceNode, "main.pl#Example::encode");
    assert.equal(call.packageName, "Example");
    assert.equal(call.conditional, true);
    assert.equal(call.range.startLine, call.name.kind === "known" && call.name.value === "normalize" ? 6 : 3);
    assert.ok(source.slice(call.range.start, call.range.end).startsWith(call.name.kind === "known" ? call.name.value : "?"));
  }
});

test("replacement lexicals stay in their implicit block and conditional writes invalidate captures", async () => {
  const f = perlRepo({ "main.pl": String.raw`sub first {} sub second {} my $cb = \&first; $text =~ s{x}{my $inner = sub {}; $inner->(); $cb = \&second; 'x'}e; $inner->(); $cb->();` });
  try {
    await f.build();
    const edges = semanticEdges(f.graph());
    assert.ok(edges.some(edge => edge.includes("$inner")), edges.join("\n"));
    assert.ok(!edges.some(edge => edge.includes("::first") || edge.includes("::second")), edges.join("\n"));
    const source = await extract(String.raw`sub f { $text =~ s{x}{my $local = sub {}; $local->()}e; $local->(); }`);
    const calls = source.languageData.calls.filter(call => call.form === "coderef");
    assert.equal(calls.length, 2);
    assert.ok(calls[0].bindingId);
    assert.equal(calls[1].bindingId, undefined);
  } finally { f.close(); }
});

test("nested replacements parse as code while ordinary patterns and strings remain text", async () => {
  const source = String.raw`sub outer { $text =~ s!looks_like(foo())!my $copy = $1; $copy =~ s{x}{helper($1)}e; "fake()"!ge; }`;
  const result = await extract(source);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.languageData.calls.map(call => call.name.kind === "known" && call.name.value), ["helper"]);
  assert.equal(result.languageData.calls[0].range.start, source.indexOf("helper"));
});

test("additional eval, regex code, escaped delimiters, and malformed replacement source remain explicit", async () => {
  for (const source of [
    '$text =~ s{x}{generated()}ee;',
    '$text =~ s{(?{ pattern_code() })}{replacement()}e;',
    String.raw`$text =~ s/x/'a\/b'/e;`,
    '$text =~ s{x}{broken(}e;',
    '$text =~ s{x}{x +}e;',
    '$text =~ s{x}{${\\interpolation()}}g;',
  ]) {
    const result = await extract(source);
    assert.ok(result.languageData.diagnostics.some(diagnostic => diagnostic.code === "PERL_EMBEDDED_CODE_UNSUPPORTED"), source);
    assert.equal(result.languageData.calls.length, 0, source);
  }
});

test("replacement calls retain possible load-state mutations", async () => {
  for (const invoked of [false, true]) {
    const f = perlRepo({ "main.pl": `sub change_path { delete $INC{'Good.pm'} } $text =~ s{x}{${invoked ? 'change_path()' : '"change_path()"'}}e; require Good; Good::run();`,
      "lib/Good.pm": "package Good; sub run {} 1;" });
    try {
      await f.build();
      assert.equal(semanticEdges(f.graph()).some(edge => edge.includes("Good::run")), !invoked);
    } finally { f.close(); }
  }
});

test("ordinary replacement expressions clear the coverage warning and reuse cached facts", async () => {
  const f = perlRepo({ "main.pl": String.raw`$text =~ s!x!; my $copy = $1; $copy =~ s/\s+/ /g; "$copy"!ge;` });
  try {
    const first = await f.build();
    assert.equal(first.perl?.partial, 0);
    const bytes = f.bytes();
    assert.equal((await f.build()).parsed, 0);
    assert.equal(f.bytes(), bytes);
  } finally { f.close(); }
});

test("embedded parsing is bounded and excess replacements stay unresolved", async () => {
  const result = await extract(Array.from({ length: 130 }, () => '$text =~ s{x}{handler()}e;').join('\n'));
  assert.equal(result.languageData.calls.length, 128);
  assert.ok(result.languageData.diagnostics.some(diagnostic => diagnostic.code === "PERL_EMBEDDED_CODE_UNSUPPORTED"));
});
