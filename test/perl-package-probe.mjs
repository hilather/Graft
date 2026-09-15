/** Run with an installed package directory, outside the checkout. No Perl runs. */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = resolve(process.argv[2]);
assert.ok(existsSync(join(packageDir, "dist/graph/perl-worker.js")));
assert.equal(existsSync(join(packageDir, "src")), false, "consumer cannot use a source fallback");
// Workers only use Node and packaged WASM. Exclude interpreters and compilers.
process.env.PATH = "";
const { PerlParser } = await import(pathToFileURL(join(packageDir, "dist/graph/perl-parser.js")).href);
const scratch = mkdtempSync(join(tmpdir(), "graft-perl-package-probe-"));
const source = "package Demo; sub run { my $re = qr{[{}]}; return 1; }\n";
const run = async (options = {}, input = source) => {
  const parser = new PerlParser(options);
  try {
    const result = await parser.extract("lib/Demo.pm", input);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(parser.workerStarts, 1);
    return result;
  } finally { await parser.dispose(); }
};
try {
  const healthy = await run();
  assert.notEqual(healthy.status, "failed");
  assert.equal(healthy.nodes[0].language, "perl");
  assert.equal(healthy.languageData.diagnostics.some((d) => d.code === "PERL_PARSE_ERROR"), false);
  const malformed = await run({}, "package Demo; sub broken { my $x = qq{unterminated\n");
  assert.equal(malformed.status, "partial");
  assert.ok(malformed.languageData.diagnostics.some((d) => d.code === "PERL_PARSE_ERROR"));
  const missing = await run({ assetsDir: pathToFileURL(join(scratch, "absent") + "/") });
  assert.equal(missing.status, "failed");
  assert.equal(missing.cacheable, false);
  assert.equal(missing.languageData.diagnostics[0].code, "PERL_ASSET_FAILED");
  const assets = join(scratch, "assets");
  cpSync(join(packageDir, "dist/graph/grammars/perl"), assets, { recursive: true });
  const wasm = join(assets, "tree-sitter-perl.wasm");
  const bytes = readFileSync(wasm);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(wasm, bytes);
  const corrupt = await run({ assetsDir: pathToFileURL(assets + "/") });
  assert.equal(corrupt.status, "failed");
  assert.match(corrupt.languageData.diagnostics[0].message, /checksum mismatch/);
  const recovered = await run();
  assert.notEqual(recovered.status, "failed");
  console.log(JSON.stringify({ node: process.version, packageDir, sourceFallback: false, path: process.env.PATH, healthy: healthy.status, malformed: malformed.status, missing: missing.status, corrupt: corrupt.status, recovered: recovered.status }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
