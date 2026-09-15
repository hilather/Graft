import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { perlRepo, runnerSource, utilSource } from "./helpers/perl-repo.js";
import { perlCliPath } from "./helpers/perl-cli.js";
import { callTool, TOOLS } from "../src/mcp/tools.js";

const names = ["graft_find_code", "graft_file_api", "graft_check_freshness", "graft_trace_calls", "graft_find_all", "graft_repo_map"];

test("canonical MCP tools preserve Perl source identity, traversal, prefixes and read-only freshness", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource });
  try {
    await f.build();
    assert.deepEqual(TOOLS.map((tool) => tool.name), names);
    const call = (name: string, args: Record<string, unknown> = {}) => callTool(f.root, name, args, f.out);
    const found = await call("graft_find_code", { query: "normalize_sentinel_409", full: true });
    assert.equal(found.isError, false); assert.match(found.text, /Acme::Util::normalize/); assert.match(found.text, /L6-L9/); assert.ok(found.text.includes(utilSource.split("\n").slice(5, 9).join("\n")));
    const api = await call("graft_file_api", { file: "lib/Acme/Util.pm" });
    assert.equal(api.isError, false); assert.match(api.text, /function Acme::Util::normalize\s+sub normalize/);
    const incoming = await call("graft_trace_calls", { symbol: "Acme::Util::normalize", in: "lib/Acme" });
    assert.equal(incoming.isError, false); assert.match(incoming.text, /bin\/runner\.pl/);
    const outgoing = await call("graft_trace_calls", { symbol: "bin/runner.pl#main::run", direction: "out", depth: 2 });
    assert.equal(outgoing.isError, false); assert.match(outgoing.text, /lib\/Acme\/Util\.pm/);
    const absent = await call("graft_trace_calls", { symbol: "Missing::normalize" });
    assert.equal(absent.isError, true); assert.ok(!absent.text.includes("bin/runner.pl"));
    const all = await call("graft_find_all", { pattern: "normalize_sentinel_409", fixed: true, in: "lib/Acme" });
    assert.equal(all.isError, false); assert.match(all.text, /Acme::Util::normalize/); assert.match(all.text, /8/);
    const bad = await call("graft_find_code", { query: "normalize", in: "missing-prefix" });
    assert.equal(bad.isError, true); assert.match(bad.text, /missing-prefix/);
    const map = await call("graft_repo_map"); assert.equal(map.isError, false); assert.match(map.text, /2 files.*perl/);
    const clean = await call("graft_check_freshness"); assert.equal(clean.isError, false); assert.match(clean.text, /OK/);
    f.write("lib/Acme/Util.pm", utilSource.replace("normalize_sentinel_409", "mcp_updated_411"));
    const bytes = f.bytes(); const stale = await call("graft_check_freshness");
    assert.equal(stale.isError, false); assert.match(stale.text, /Acme::Util::normalize/); assert.equal(f.bytes(), bytes);
    const refreshed = await call("graft_find_code", { query: "mcp_updated_411", full: true });
    assert.equal(refreshed.isError, false); assert.match(refreshed.text, /mcp_updated_411/); assert.notEqual(f.bytes(), bytes);
  } finally { f.close(); }
});

test("MCP scoped qualified lookups do not cross identical package names in separate distributions", async () => {
  const f = perlRepo({
    "services/a/Makefile.PL": "# project marker only\n", "services/b/Build.PL": "# project marker only\n",
    "services/a/lib/Acme/Util.pm": utilSource, "services/b/lib/Acme/Util.pm": utilSource,
    "services/a/bin/runner.pl": runnerSource, "services/b/bin/runner.pl": runnerSource,
  }, null);
  try {
    await f.build();
    const result = await callTool(f.root, "graft_trace_calls", { symbol: "Acme::Util::normalize", in: "services/a" }, f.out);
    assert.equal(result.isError, false); assert.match(result.text, /services\/a\/bin\/runner\.pl/); assert.ok(!result.text.includes("services/b"));
    assert.deepEqual(await callTool(f.root, "graft_trace_calls", { symbol: "Acme::Util::normalize", in: join("services", "a") }, f.out), result);
  } finally { f.close(); }
});

test("built MCP stdio serves Perl queries and refreshes without parser output on protocol stdout", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource });
  await f.build();
  const child = spawn(process.execPath, [perlCliPath, "--dir", f.out, "mcp", f.root], { cwd: f.root, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const noise: string[] = [];
  let buffer = "", stderr = "", nextId = 1;
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try { const response = JSON.parse(line); pending.get(response.id)?.resolve(response); pending.delete(response.id); }
      catch { noise.push(line); }
    }
  });
  child.on("exit", () => { for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited: ${stderr}`)); pending.clear(); });
  const rpc = (method: string, params?: object) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${stderr}; noise=${noise.join("\n")}`)); }, 20_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "perl-fixture", version: "1" } });
    assert.equal(init.result.serverInfo.name, "graft");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await rpc("tools/list"); assert.deepEqual(list.result.tools.map((tool: { name: string }) => tool.name), names);
    const first = await rpc("tools/call", { name: "graft_trace_calls", arguments: { symbol: "Acme::Util::normalize" } });
    assert.ok(!first.error && !first.result.isError); assert.match(first.result.content[0].text, /bin\/runner\.pl/);
    f.write("lib/Acme/Util.pm", utilSource + "\nsub Acme::Util::stdio_added {}\n");
    const refreshed = await rpc("tools/call", { name: "graft_file_api", arguments: { file: "lib/Acme/Util.pm" } });
    assert.ok(!refreshed.error && !refreshed.result.isError); assert.match(refreshed.result.content[0].text, /Acme::Util::stdio_added/);
    assert.deepEqual(noise, []); assert.equal(buffer.trim(), "");
  } finally { child.kill(); await exited; f.close(); }
});
