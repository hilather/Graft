/** Installed-artifact release probe. Supply package directory and absolute Git executable. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = resolve(process.argv[2]), gitPath = resolve(process.argv[3]);
assert.ok(existsSync(join(packageDir, "dist/cli.js")));
assert.equal(existsSync(join(packageDir, "src")), false);
const scratch = mkdtempSync(join(tmpdir(), "graft installed Péर्ल "));
const bin = join(scratch, "bin"), root = join(scratch, "repo ü"), out = join(root, "graft");
mkdirSync(bin); mkdirSync(root);
// Explicit allowlist: no interpreter, compiler or CPAN command is on PATH.
symlinkSync(process.execPath, join(bin, process.platform === "win32" ? "node.exe" : "node"));
symlinkSync(gitPath, join(bin, process.platform === "win32" ? "git.exe" : "git"));
process.env.PATH = bin; process.env.CI = "1"; process.env.DO_NOT_TRACK = "1";
const cliPath = join(packageDir, "dist/cli.js");
const cli = (args, repo = root) => {
  const r = spawnSync(process.execPath, [cliPath, "--dir", join(repo, "graft"), ...args, repo], { cwd: repo, encoding: "utf8", timeout: 45_000 });
  assert.ifError(r.error); return r;
};
const good = args => { const r = cli(args); assert.equal(r.status, 0, r.stdout + r.stderr); return r; };
const json = args => JSON.parse(good([...args, "--json"]).stdout);
const write = (path, text) => { const p = join(root, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const git = (...args) => {
  const r = spawnSync(gitPath, ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: root, encoding: "utf8", timeout: 15_000 });
  assert.equal(r.status, 0, r.stderr);
};
const util = "package Acme::Util;\nuse strict;\nuse warnings;\nuse Exporter 'import';\nour @EXPORT_OK = qw(normalize);\nsub normalize {\n    my ($value) = @_;\n    return lc $value; # installed_sentinel_409\n}\n1;\n";
const utilId = "lib/Acme/Util.pm#Acme::Util::normalize";
const runnerId = "bin/runner#main::run";
const assets = join(packageDir, "dist/graph/grammars/perl"), wasm = join(assets, "tree-sitter-perl.wasm");
const wasmBytes = readFileSync(wasm), provenance = JSON.parse(readFileSync(join(assets, "provenance.json")));
assert.equal(createHash("sha256").update(wasmBytes).digest("hex"), provenance.files["tree-sitter-perl.wasm"].sha256);
const importInstalled = path => import(pathToFileURL(join(packageDir, "dist", path)).href);
try {
  write("graft.perl.json", JSON.stringify({ version: 1, projects: [{ root: ".", analysisCwd: ".", includeRoots: ["lib"] }] }));
  write("lib/Acme/Util.pm", util);
  write("bin/runner", "#!/usr/bin/perl\nuse Acme::Util qw(normalize);\nsub run { normalize('PAYLOAD') }\nsub entry { run() }\nentry();\n");
  write("other.pm", "package Other; sub normalize {}\n");
  write("docs/manual.pod", "=pod\nsub fake {}\n=cut\n");
  write("Makefile.PL", "BEGIN { open my $f, '>', 'perl_was_executed'; print {$f} 'bad'; }\n");
  write("native.ts", "export function nativeHealthy() { return 42 }\n");
  git("init", "-b", "main"); git("config", "user.name", "Installed fixture"); git("config", "user.email", "fixture@example.invalid");
  good(["build", "--no-reuse"]);
  const { wiringPath } = await importInstalled("graph/write.js");
  const graphPath = wiringPath(out), cold = readFileSync(graphPath, "utf8");
  const graph = JSON.parse(cold);
  assert.deepEqual(graph.meta.languages, ["perl", "typescript"]);
  assert.ok(graph.edges.some(e => e.source === runnerId && e.target === utilId && e.relation === "calls" && e.confidence === "extracted"));
  assert.ok(!graph.nodes.some(n => n.name === "fake"));
  good(["build"]); assert.equal(readFileSync(graphPath, "utf8"), cold);
  const api = await importInstalled("index.js");
  const checked = await api.checkGraph(root, { contextDir: out });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  good(["check", "--json"]);
  const found = json(["ask", "installed_sentinel_409", "--source", "--full"]);
  assert.equal(found.hits[0].pointer, "lib/Acme/Util.pm:L6-L9");
  assert.equal(found.hits[0].code, util.split("\n").slice(5, 9).join("\n"));
  const skel = json(["skeleton", "lib/Acme/Util.pm"]);
  assert.deepEqual(skel.entries.map(e => e.name), ["Acme::Util", "Acme::Util::normalize"]);
  const grep = json(["grep", "installed_sentinel_409", "--fixed"]);
  assert.equal(grep.totalHits, 1); assert.equal(grep.groups[0].symbol.id, utilId);
  assert.deepEqual(json(["callers", "Acme::Util::normalize"]).matches[0].hits.map(h => h.id), [runnerId]);
  assert.deepEqual(json(["callers", "main::entry", "--direction", "out", "--depth", "2"]).matches[0].hits.filter(h => h.relation === "calls").map(h => h.id).sort(), [runnerId, utilId].sort());
  assert.notEqual(cli(["callers", "Missing::normalize"]).status, 0);
  const map = json(["map"]); assert.equal(map.totals.files, 6); assert.deepEqual(map.totals.languages, ["perl", "typescript"]);
  assert.ok(json(["ask", "installed_sentinel_409", "--in", "lib/Acme"]).hits.every(h => h.pointer.startsWith("lib/Acme/")));
  assert.match(readFileSync(join(out, "INDEX.md"), "utf8"), /6 per-file wiring cards/);
  assert.match(readFileSync(join(out, "lib/Acme/Util.md"), "utf8"), /Acme::Util::normalize/);
  const { listContextFiles, CODE_EXTENSIONS } = await importInstalled("context/build.js");
  assert.equal(listContextFiles(root, out, CODE_EXTENSIONS).length, 6);
  const deep = await api.buildContext(root, { contextDir: out, model: "fixture", summarizer: { async summarize(code) { return code; } }, synthesizer: { async synthesize(files) { return [{ name: "Installed Perl", type: "concept", summary: "Installed fixture", sources: files.map(f => f.path), links: [] }]; } } });
  assert.equal(deep.failedFiles, 0); assert.equal(deep.files, 6);
  good(["build"]); assert.match(readFileSync(join(out, "installed-perl.md"), "utf8"), /Acme::Util::normalize/);
  git("add", "-A"); git("commit", "-m", "fixture source");
  write("lib/Acme/Util.pm", util.replace("return lc $value", "return uc $value"));
  const beforeCheck = readFileSync(graphPath, "utf8");
  assert.notEqual(cli(["check", "--json"]).status, 0); assert.equal(readFileSync(graphPath, "utf8"), beforeCheck);
  const blast = JSON.parse(good(["blast", "--format", "json", "--no-owners"]).stdout);
  assert.deepEqual(blast.seeds.map(s => s.id), [utilId]); assert.ok(blast.impacted.some(h => h.id === runnerId));
  assert.ok(!blast.impacted.some(h => h.path === "other.pm"));
  assert.match(json(["ask", "installed_sentinel_409", "--source", "--full"]).hits[0].code, /return uc/);

  const child = spawn(process.execPath, [cliPath, "--dir", out, "mcp", root], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit"), pending = new Map(), noise = []; let buffer = "", stderr = "", id = 0;
  child.stderr.on("data", b => { stderr += b; });
  child.stdout.on("data", b => {
    buffer += b; let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
      try { const r = JSON.parse(line); pending.get(r.id)?.resolve(r); pending.delete(r.id); } catch { noise.push(line); }
    }
  });
  child.on("exit", () => { for (const p of pending.values()) p.reject(Error(stderr)); pending.clear(); });
  const rpc = (method, params) => new Promise((resolveRpc, reject) => {
    const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(Error(`MCP timeout: ${stderr}`)); }, 20_000);
    pending.set(requestId, { resolve: r => { clearTimeout(timer); resolveRpc(r); }, reject: e => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  try {
    assert.equal((await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "installed-probe", version: "1" } })).result.serverInfo.name, "graft");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const calls = [
      ["graft_find_code", { query: "installed_sentinel_409", full: true }, /return uc/],
      ["graft_file_api", { file: "lib/Acme/Util.pm" }, /Acme::Util::normalize/],
      ["graft_check_freshness", {}, /OK/],
      ["graft_trace_calls", { symbol: "Acme::Util::normalize" }, /bin\/runner/],
      ["graft_find_all", { pattern: "installed_sentinel_409", fixed: true }, /normalize/],
      ["graft_repo_map", {}, /perl/],
    ];
    assert.deepEqual((await rpc("tools/list")).result.tools.map(t => t.name).sort(), calls.map(c => c[0]).sort());
    for (const [name, args, pattern] of calls) {
      const response = await rpc("tools/call", { name, arguments: args });
      assert.ok(!response.error && !response.result.isError, JSON.stringify(response)); assert.match(response.result.content[0].text, pattern);
    }
    write("lib/Acme/Util.pm", util + "\nsub Acme::Util::installed_added {}\n");
    const added = await rpc("tools/call", { name: "graft_file_api", arguments: { file: "lib/Acme/Util.pm" } });
    assert.match(added.result.content[0].text, /installed_added/); assert.deepEqual(noise, []);
  } finally { child.kill(); await exited; }

  const nativeRoot = join(scratch, "native only"); mkdirSync(nativeRoot); writeFileSync(join(nativeRoot, "native.ts"), "export function nativeHealthy() {}\n");
  for (const mode of ["missing", "corrupt"]) {
    if (mode === "missing") renameSync(wasm, wasm + ".saved");
    else { const bytes = Buffer.from(wasmBytes); bytes[0] ^= 1; writeFileSync(wasm, bytes); }
    try {
      const broken = cli(["build", "--no-reuse"]);
      assert.match(broken.stdout + broken.stderr, /PERL_ASSET_FAILED/);
      const partial = JSON.parse(readFileSync(graphPath));
      assert.ok(partial.nodes.some(n => n.id === "native.ts#nativeHealthy"));
      assert.ok(!partial.nodes.some(n => n.id === utilId));
      const nativeBuild = cli(["build", "--no-reuse"], nativeRoot); assert.equal(nativeBuild.status, 0, nativeBuild.stderr);
      const nativeQuery = cli(["ask", "nativeHealthy", "--json"], nativeRoot); assert.equal(nativeQuery.status, 0, nativeQuery.stderr); assert.match(nativeQuery.stdout, /nativeHealthy/);
    } finally { if (mode === "missing") renameSync(wasm + ".saved", wasm); else writeFileSync(wasm, wasmBytes); }
  }
  good(["build", "--no-reuse"]); assert.ok(JSON.parse(readFileSync(graphPath)).nodes.some(n => n.id === utilId));
  assert.equal(existsSync(join(root, "perl_was_executed")), false);
  console.log(JSON.stringify({ node: process.version, packageDir, grammarSha256: provenance.files["tree-sitter-perl.wasm"].sha256, pathAllowlist: ["node", "git"], sourceFallback: false, unicodeAndSpaces: true, cli: "pass", publicLibrary: "pass", deepCardsCovers: "pass", blast: "pass", mcpTools: 6, missingCorruptNativeContinuity: "pass", analyzedPerlExecuted: false }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
