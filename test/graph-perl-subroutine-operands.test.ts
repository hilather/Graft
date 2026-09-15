import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import { extractPerlTree } from "../src/graph/perl-extract.js";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

await Parser.init();
const language = await Language.load(readFileSync(new URL("../src/graph/grammars/perl/tree-sitter-perl.wasm", import.meta.url)));
function facts(source: string) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    assert.equal(tree.rootNode.hasError, false, source);
    return extractPerlTree("main.pl", source, tree.rootNode).languageData;
  } finally { tree.delete(); parser.delete(); }
}

test("defined and exists inspect named and computed subroutines without invoking them", () => {
  for (const operator of ["defined", "exists", "CORE::defined", "CORE::exists"]) {
    for (const operand of ["&missing", "&P::missing", "&$callback", "&{$name}", "(( &missing ))", "# before\n (( # grouped\n &missing )) # after\n"]) {
      const source = `${operator}(${operand});`;
      const result = facts(source);
      assert.deepEqual(result.calls, [], source);
      assert.deepEqual(result.references, [], source);
      assert.deepEqual(result.mutations, [], source);
      assert.deepEqual(result.diagnostics, [], source);
    }
  }
});

test("parenthesized ampersand calls and explicit functions named defined still execute", () => {
  for (const source of ["defined &run();", "defined(&run(argument()));", "CORE::defined(&run(argument()));", "defined($x = &run);", "&defined(&run);", "P::defined(&run);"]) {
    const result = facts(source);
    const names = result.calls.map(call => call.name.kind === "known" ? call.name.value : "?");
    assert.equal(names.filter(name => name === "run").length, 1, source);
    if (source.includes("argument()")) {
      assert.equal(names.filter(name => name === "argument").length, 1, source);
      assert.notEqual(result.calls.find(call => call.name.kind === "known" && call.name.value === "run")?.emptyArguments, true);
    }
  }
});

test("computing a subroutine operand or code reference retains nested calls and mutations", () => {
  for (const source of ["defined &{select_name()};", "exists &{select_name()};", "CORE::defined(&{select_name()});", String.raw`\&{select_name()};`, "&{select_name()}(argument());"]) {
    const result = facts(source);
    const selected = result.calls.filter(call => call.name.kind === "known" && call.name.value === "select_name");
    assert.equal(selected.length, 1, source);
    assert.equal(source.slice(selected[0].range.start, selected[0].range.end), "select_name()");
    if (source.includes("argument()")) assert.ok(result.calls.some(call => call.name.kind === "known" && call.name.value === "argument"));
  }
  const result = facts("defined &{delete $INC{'Good.pm'}; select_name()};");
  assert.ok(result.includeEffects.some(effect => effect.affectsLoaded));
});

test("undefining a subroutine records a mutation rather than invoking the old body", () => {
  for (const source of ["undef &run;", "undef(&run);", "undef # comment\n &run;", "CORE::undef(&run);", "CORE::undef &run;"]) {
    const result = facts(`package P; ${source}`);
    assert.deepEqual(result.calls, [], source);
    assert.deepEqual(result.mutations.map(mutation => mutation.names), [{ kind: "known", value: ["P::run"] }], source);
  }
  const result = facts("undef &{select_name()};");
  assert.ok(result.calls.some(call => call.name.kind === "known" && call.name.value === "select_name"));
  assert.ok(result.mutations.some(mutation => mutation.names.kind === "unknown"));
  const lexical = facts("my sub run {} undef &run; run();");
  assert.ok(lexical.bindings.find(binding => binding.name === "run")?.invalidations.some(invalidation => invalidation.reason === "assignment"));
});

test("existence checks do not activate deferred load mutations, including after cache reuse", async () => {
  const main = "sub change { delete $INC{'Good.pm'} } defined &change; exists &{$name}; require Good; Good::run();";
  const f = perlRepo({ "main.pl": main, "lib/Good.pm": "package Good; sub run {} 1;" });
  try {
    await f.build();
    assert.deepEqual(semanticEdges(f.graph()), ["main.pl -> lib/Good.pm#Good::run [extracted]"]);
    const diagnostics = JSON.parse(readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8"));
    assert.deepEqual(diagnostics.files["main.pl"].diagnostics.map((diagnostic: { code: string }) => diagnostic.code), ["PERL_INCLUDE_PATH_UNKNOWN"]);
    const cold = f.bytes();
    assert.equal((await f.build()).parsed, 0);
    assert.equal(f.bytes(), cold);
    f.write("main.pl", main.replace("defined &change;", "defined &change();"));
    assert.equal((await f.build()).parsed, 1);
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes("Good::run")));
  } finally { f.close(); }
  const imported = perlRepo({
    "main.pl": "use Helper; require Good; Good::run();",
    "lib/Helper.pm": "package Helper; sub unused { delete $INC{'Good.pm'} } sub import { defined &unused; exists &{$name}; } 1;",
    "lib/Good.pm": "package Good; sub run {} 1;",
  });
  try { await imported.build(); assert.ok(semanticEdges(imported.graph()).some(edge => edge.includes("Good::run"))); }
  finally { imported.close(); }
});

test("operand evaluation and undefinition still invalidate later graph targets", async () => {
  for (const expression of ["defined &{change()};", "exists &{change()};", String.raw`my $ref = \&{change()};`]) {
    const f = perlRepo({ "main.pl": `sub change { delete $INC{'Good.pm'}; 'unused' } ${expression} require Good; Good::run();`, "lib/Good.pm": "package Good; sub run {} 1;" });
    try { await f.build(); assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes("Good::run")), expression); }
    finally { f.close(); }
  }
  const f = perlRepo({ "main.pl": "sub run {} undef &run; run();" });
  try { await f.build(); assert.deepEqual(semanticEdges(f.graph()), []); }
  finally { f.close(); }
});
