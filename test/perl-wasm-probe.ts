/** Out-of-process CST oracle. These are parse inputs, never executed Perl.
 * Kept separate so a scanner/V8 failure cannot kill the parent test runner. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Parser, Language, type Node } from "web-tree-sitter";

const asset = process.argv[2] ?? fileURLToPath(new URL("../src/graph/grammars/perl/tree-sitter-perl.wasm", import.meta.url));
const group = process.argv[3] ?? "syntax";
const started = performance.now();
await Parser.init();
const language = await Language.load(readFileSync(asset));
assert.equal(language.abiVersion, 15);
const startupMs = performance.now() - started;
let parses = 0;
let maxParseMs = 0;

function descendants(node: Node, type: string): Node[] {
  const found: Node[] = [];
  const stack = [node];
  while (stack.length) {
    const next = stack.pop()!;
    if (next.type === type) found.push(next);
    stack.push(...[...next.namedChildren].reverse());
  }
  return found;
}

function parse(source: string, inspect: (root: Node) => void, error = false): void {
  const parser = new Parser();
  const start = performance.now();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(source);
    assert.ok(tree);
    try {
      assert.equal(tree.rootNode.hasError, error, tree.rootNode.toString());
      inspect(tree.rootNode);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
  parses++;
  maxParseMs = Math.max(maxParseMs, performance.now() - start);
}

function subNames(root: Node): string[] {
  return descendants(root, "subroutine_declaration_statement")
    .map((n) => n.childForFieldName("name")!.text);
}

if (group === "syntax") {
  parse("package Acme::Util 1.2; sub work ($value) { return $value } package Other v1.2.3 { sub work {} }", (root) => {
    const packages = descendants(root, "package_statement");
    assert.deepEqual(packages.map((n) => n.childForFieldName("name")?.text), ["Acme::Util", "Other"]);
    assert.deepEqual(packages.map((n) => n.childForFieldName("version")?.text), ["1.2", "v1.2.3"]);
    assert.equal(packages[0].namedChildren.some((n) => n.type === "block"), false);
    assert.equal(packages[1].namedChildren.some((n) => n.type === "block"), true);
    assert.deepEqual(subNames(root), ["work", "work"]);
    const sub = descendants(root, "subroutine_declaration_statement")[0];
    assert.equal(sub.childForFieldName("body")?.text, "{ return $value }");
    assert.equal(descendants(sub, "signature")[0]?.text, "($value)");
  });
  parse("my sub inner { 1 } state sub memo { 2 } our sub visible {} sub Other::forward; sub Other::forward ($$) { 1 } sub attr :lvalue { 1 }", (root) => {
    const subs = descendants(root, "subroutine_declaration_statement");
    assert.deepEqual(subNames(root), ["inner", "memo", "visible", "Other::forward", "Other::forward", "attr"]);
    assert.deepEqual(subs.slice(0, 3).map((n) => n.childForFieldName("lexical")?.text ?? null), ["my", "state", null]);
    assert.equal(subs[2].children[0].type, "our");
    assert.equal(subs[3].childForFieldName("body"), null);
    assert.equal(descendants(subs[4], "prototype")[0]?.text, "($$)");
    // The colon is a sibling token; signatures must slice source, not rebuild
    // an attribute list by concatenating only named CST nodes.
    assert.equal(descendants(subs[5], "attrlist")[0]?.text, "lvalue");
  });
  parse("sub combine ($$) :lvalue { 1 } sub forward ($$) :lvalue; my $cb = sub ($$) :lvalue { 1 }; sub signature :lvalue ($x) { $x }", (root) => {
    assert.deepEqual(subNames(root), ["combine", "forward", "signature"]);
    assert.equal(descendants(root, "prototype").length, 3);
    assert.equal(descendants(root, "signature").length, 1);
    assert.equal(descendants(root, "attrlist").length, 4);
  });
  parse("class Point { field $x :param; method get { $x } ADJUST { $x++ } }", (root) => {
    assert.equal(descendants(root, "class_statement")[0]?.childForFieldName("name")?.text, "Point");
    assert.equal(descendants(root, "method_declaration_statement")[0]?.childForFieldName("name")?.text, "get");
    const field = descendants(root, "variable_declaration")[0];
    assert.equal(field.children[0].type, "field");
    assert.equal(field.childForFieldName("variable")?.text, "$x");
    assert.equal(descendants(root, "class_phaser_statement").length, 1);
  });
  parse("use Exporter 'import'; our @EXPORT_OK = qw(work); use Acme::Util (); require 'legacy.pl'; Acme::Util::work(); \\&work;", (root) => {
    const uses = descendants(root, "use_statement");
    assert.deepEqual(uses.map((n) => n.childForFieldName("module")?.text), ["Exporter", "Acme::Util"]);
    assert.equal(descendants(uses[1], "stub_expression")[0]?.text, "()");
    assert.equal(descendants(root, "require_expression").length, 1);
    assert.equal(descendants(root, "function_call_expression")[0]?.childForFieldName("function")?.text, "Acme::Util::work");
    assert.equal(descendants(root, "refgen_expression").length, 1);
  });
} else if (group === "islands") {
  for (const source of [
    "my $s = <<'END';\nsub fake {}\nEND\nsub real {}",
    "my ($a,$b) = (<<'FIRST', <<'SECOND');\npackage Fake;\nFIRST\nsub fake {}\nSECOND\nsub real {}",
    "my $s = q{sub fake {}}; my $r = qr/package Fake; sub ghost {}/;\n=pod\nsub podfake {}\n=cut\nsub real {}\n__DATA__\nsub datafake {}",
    "my $s = qq{=pod\\nsub fake {}}; my $r = m{[{}]}; sub real {}\n__END__\npackage Ghost; sub endfake {}",
  ]) parse(source, (root) => {
    assert.deepEqual(subNames(root), ["real"]);
    assert.deepEqual(descendants(root, "package_statement"), []);
  });
  for (const pattern of [
    "m{[{}]}", "qr{[{abc}]}", "m[[abc]]", "m/[{}]/", "m{a{2}}",
    "m{[\\{\\}]}", "m{[abc$var]}", "m{[[:alpha:]]}",
  ]) parse(`my $r = ${pattern}; sub after_pattern {}`, (root) => {
    assert.deepEqual(subNames(root), ["after_pattern"]);
    assert.equal(descendants(root, "package_statement").length, 0);
  });
} else if (group === "positions") {
  // JS API offsets/columns must index decoded UTF-16 strings, even when a
  // supplementary Unicode character precedes a definition on the same line.
  for (const source of [
    "\uFEFF# café 😀\r\npackage Café;\r\nmy $s = '😀'; sub résumé { 1 }\r\n",
    "# café 😀\npackage Café;\nmy $s = '😀'; sub résumé { 1 }\n",
    "# prefix\n" + " ".repeat(40_000) + "sub after_chunk { 1 }",
  ]) parse(source, (root) => {
    const sub = descendants(root, "subroutine_declaration_statement")[0];
    const index = source.indexOf("sub ");
    assert.equal(sub.startIndex, index);
    assert.equal(source.slice(sub.startIndex, sub.endIndex), sub.text);
    const before = source.slice(0, index);
    assert.equal(sub.startPosition.row, before.split("\n").length - 1);
    assert.equal(sub.startPosition.column, index - before.lastIndexOf("\n") - 1);
  });
} else if (group === "recovery") {
  parse('my $s = "a\0b"; sub after_nul {}', (root) => assert.deepEqual(subNames(root), ["after_nul"]));
  parse('my $s="unterminated;\nsub rescued {}', (root) => assert.deepEqual(subNames(root), ["rescued"]), true);
  for (const source of ["my $s = <<'END';\nmissing terminator\n", "my $s=q{unterminated;", "sub broken {", "my $r = qr{unterminated;"]) {
    parse(source, () => {}, true);
    parse("package Healthy; sub ok { 1 }", (root) => assert.deepEqual(subNames(root), ["ok"]));
  }
} else if (group === "repeat") {
  for (let i = 0; i < 50; i++) parse("sub warmup { 1 }", () => {});
  global.gc?.();
  const before = process.memoryUsage();
  for (let i = 0; i < 1_000; i++) parse("package Repeat; my $s = <<'END';\nsub fake {}\nEND\nsub real { 1 }", (root) => assert.deepEqual(subNames(root), ["real"]));
  global.gc?.();
  console.log(JSON.stringify({ memoryBefore: before, memoryAfter: process.memoryUsage() }));
} else {
  throw new Error(`Unknown probe group: ${group}`);
}
console.log(JSON.stringify({ group, abi: language.abiVersion, startupMs, parses, maxParseMs }));
