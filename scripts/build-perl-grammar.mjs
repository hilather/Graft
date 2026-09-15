/** Maintainer-only, offline rebuild of the pinned Perl grammar. No project Perl
 * or package lifecycle scripts are executed. */
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  source: { type: "string" },
  "wasi-sdk": { type: "string" },
  "tree-sitter": { type: "string", default: "tree-sitter" },
  verify: { type: "boolean", default: false },
} });
const assets = resolve(dirname(fileURLToPath(import.meta.url)), "../src/graph/grammars/perl");
const manifest = JSON.parse(readFileSync(join(assets, "provenance.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function assertHash(path, expected) {
  const actual = hash(readFileSync(path));
  if (actual !== expected) throw new Error(`Checksum mismatch for ${path}: ${actual} (expected ${expected})`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 300_000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message ?? result.signal ?? result.status}\n${result.stderr ?? ""}`);
  }
  return result.stdout.trim();
}

if (values.verify) {
  for (const [file, info] of Object.entries(manifest.files)) assertHash(join(assets, file), info.sha256);
  console.log(`Verified Perl grammar ${manifest.revision} and packaged license/schema.`);
} else {
  if (!values.source || !values["wasi-sdk"]) {
    throw new Error("Usage: node scripts/build-perl-grammar.mjs --verify | --source <pinned source> --wasi-sdk <SDK 29 directory> [--tree-sitter <CLI 0.26.9>]");
  }
  const source = resolve(values.source);
  const sdk = resolve(values["wasi-sdk"]);
  const cli = values["tree-sitter"];
  const version = run(cli, ["--version"]);
  if (!new RegExp(`^tree-sitter ${manifest.generator.version.replaceAll(".", "\\.")}(?: |$)`).test(version)) {
    throw new Error(`Expected tree-sitter ${manifest.generator.version}; found ${version}`);
  }
  const compiler = run(join(sdk, "bin", process.platform === "win32" ? "clang.exe" : "clang"), ["--version"]);
  if (!compiler.split("\n")[0].includes(manifest.compiler.clang)) {
    throw new Error(`Expected clang ${manifest.compiler.clang}; found ${compiler.split("\n")[0]}`);
  }
  // Copy only reviewed inputs. A dirty checkout cannot inject generated C,
  // headers, helper JS, or compiler flags into the artifact build.
  const scratch = mkdtempSync(join(tmpdir(), "graft-perl-build-"));
  try {
    for (const [file, expected] of Object.entries(manifest.inputSha256)) {
      assertHash(join(source, file), expected);
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      copyFileSync(join(source, file), join(scratch, file));
    }
    assertHash(join(source, "LICENSE"), manifest.files.LICENSE.sha256);
    for (const patch of manifest.patches ?? []) {
      const path = join(assets, patch.file);
      assertHash(path, manifest.files[patch.file].sha256);
      run("git", ["apply", "--check", path], { cwd: scratch });
      run("git", ["apply", path], { cwd: scratch });
      assertHash(join(scratch, patch.path), patch.resultSha256);
    }
    // Do not let a developer's CFLAGS/CC or a CLI SDK auto-download alter the
    // pinned recipe. The explicitly supplied SDK is the only build toolchain.
    const env = { ...process.env, TREE_SITTER_WASI_SDK_PATH: sdk };
    for (const key of ["CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS"]) delete env[key];
    const options = { cwd: scratch, env };
    run(cli, ["generate"], options);
    const generated = readFileSync(join(scratch, "src/parser.c"), "utf8");
    if (!generated.includes(`#define LANGUAGE_VERSION ${manifest.generator.abi}\n`)) {
      throw new Error("Generated parser ABI differs from the reviewed manifest");
    }
    run(cli, ["build", "--wasm", "--output", join(scratch, "tree-sitter-perl.wasm")], options);
    // Verify before replacing any tracked asset. A differing build is a new
    // parser candidate for review, never an automatic provenance update.
    assertHash(join(scratch, "src/node-types.json"), manifest.files["node-types.json"].sha256);
    assertHash(join(scratch, "tree-sitter-perl.wasm"), manifest.files["tree-sitter-perl.wasm"].sha256);
    copyFileSync(join(scratch, "tree-sitter-perl.wasm"), join(assets, "tree-sitter-perl.wasm"));
    copyFileSync(join(scratch, "src/node-types.json"), join(assets, "node-types.json"));
    console.log(`Reproduced Perl grammar ${manifest.revision} (ABI ${manifest.generator.abi}).`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
