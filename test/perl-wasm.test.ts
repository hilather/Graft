import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const assets = new URL("../src/graph/grammars/perl/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("provenance.json", assets), "utf8"));

test("Perl grammar, generated schema and license match pinned provenance", () => {
  for (const [file, info] of Object.entries(manifest.files) as [string, { sha256: string; bytes: number }][]) {
    const bytes = readFileSync(new URL(file, assets));
    assert.equal(bytes.length, info.bytes, file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), info.sha256, file);
  }
  assert.match(readFileSync(new URL("LICENSE", assets), "utf8"), /Copyright 2025 Avishai/);
  const schema = JSON.parse(readFileSync(new URL("node-types.json", assets), "utf8"));
  for (const [type, fields] of [
    ["package_statement", ["name", "version"]],
    ["subroutine_declaration_statement", ["name", "body", "lexical"]],
    ["method_declaration_statement", ["name", "body"]],
    ["use_statement", ["module"]],
    ["function_call_expression", ["function"]],
  ] as const) {
    const entry = schema.find((n: { type: string; named: boolean }) => n.type === type && n.named);
    assert.ok(entry, type);
    for (const field of fields) assert.ok(entry.fields[field], `${type}.${field}`);
  }
});

for (const group of ["syntax", "islands", "positions", "recovery", "repeat"]) {
  test(`Perl WASM ${group} on Node ${process.versions.node}`, () => {
    const run = spawnSync(process.execPath, [
      "--expose-gc", "--import", "tsx", fileURLToPath(new URL("./perl-wasm-probe.ts", import.meta.url)),
      fileURLToPath(new URL("tree-sitter-perl.wasm", assets)), group,
    ], { encoding: "utf8", timeout: 15_000 });
    assert.equal(run.error, undefined, `${run.error?.message}\n${run.stderr}`);
    assert.equal(run.status, 0, `${run.signal ?? ""}\n${run.stdout}\n${run.stderr}`);
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
    assert.equal(result.group, group);
    assert.ok(result.parses > 0);
  });
}
