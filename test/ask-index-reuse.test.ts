import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeAskIndex } from "../src/ask/index-file.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const graph = (): GraphV1 => ({ version: 1, edges: [], nodes: [{
  id: "lib/example.ts#work", name: "work", path: "lib/example.ts", kind: "function",
  span: "L1-L1", signature: "function work(): string", language: "typescript", origin: "ast",
  exported: false, body_hash: "unchanged-source-hash", body_text: "return needle",
  summary: null, summary_state: "pending", crux: null,
}] });
const markedTime = new Date("2000-01-01T00:00:00Z");
const mark = (path: string) => { utimesSync(path, markedTime, markedTime); return statSync(path).mtimeMs; };

test("unchanged ask output is reused across processes and damaged bytes are repaired despite matching stats", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-index-reuse ü-"));
  try {
    const input = graph(), path = writeAskIndex(dir, input), bytes = readFileSync(path, "utf8");
    const mtime = mark(path), size = statSync(path).size;
    const inputPath = join(dir, "input.json");
    writeFileSync(inputPath, JSON.stringify(input));
    const moduleUrl = new URL("../src/ask/index-file.ts", import.meta.url).href;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { readFileSync } from 'node:fs'; import { writeAskIndex } from ${JSON.stringify(moduleUrl)};
       writeAskIndex(process.argv[1], JSON.parse(readFileSync(process.argv[2], 'utf8')));`, dir, inputPath]);
    assert.equal(statSync(path).mtimeMs, mtime, "a fresh process reuses the verified on-disk index");
    assert.equal(readFileSync(path, "utf8"), bytes);

    const damaged = bytes.replaceAll("needle", "poison");
    assert.notEqual(damaged, bytes);
    writeFileSync(path, damaged);
    mark(path);
    assert.equal(statSync(path).size, size);
    writeAskIndex(dir, input);
    assert.equal(readFileSync(path, "utf8"), bytes, "content hashes detect same-size, same-mtime corruption");
    assert.notEqual(statSync(path).mtimeMs, mtime);

    unlinkSync(path);
    writeAskIndex(dir, input);
    assert.equal(readFileSync(path, "utf8"), bytes, "missing output is regenerated");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ask reuse covers every indexing field, complete id rosters and qualified-name fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-index-inputs-"));
  try {
    const original = graph(), path = writeAskIndex(dir, original);
    const changes: Partial<NodeV1>[] = [
      { id: "lib/example.ts#replacement" }, { name: "renamed" }, { qualified_name: "Acme::qualified" },
      { path: "different/location.ts" }, { signature: "function work(argument: number)" },
      { summary: "Searchable description" }, { body_text: "different needle body" },
    ];
    for (const [i, change] of changes.entries()) {
      writeAskIndex(dir, original);
      const changed = structuredClone(original);
      Object.assign(changed.nodes[0], change);
      assert.equal(changed.nodes[0].body_hash, original.nodes[0].body_hash);
      writeAskIndex(dir, changed);
      const fresh = writeAskIndex(join(dir, `fresh-${i}`), changed);
      assert.equal(readFileSync(path, "utf8"), readFileSync(fresh, "utf8"), JSON.stringify(change));
      assert.notEqual(readFileSync(path, "utf8"), readFileSync(writeAskIndex(join(dir, "baseline"), original), "utf8"));
    }
    const qualified = graph();
    qualified.nodes[0].qualified_name = "Acme::work";
    writeAskIndex(dir, qualified);
    const mtime = mark(path);
    qualified.nodes[0].name = "irrelevantFallback";
    qualified.nodes[0].body_hash = "different-source-hash";
    writeAskIndex(dir, qualified);
    assert.equal(statSync(path).mtimeMs, mtime, "only the fields consumed by indexing affect reuse");
    delete qualified.nodes[0].qualified_name;
    writeAskIndex(dir, qualified);
    assert.ok(readFileSync(path, "utf8").includes("fallback"));
    writeAskIndex(dir, { version: 1, nodes: [], edges: [] });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).docCount, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing, invalid and unwritable ask reuse metadata never prevents regeneration", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-index-state-"));
  try {
    const input = graph(), path = writeAskIndex(dir, input), bytes = readFileSync(path, "utf8");
    const statePath = join(dirname(path), "ask-index-state.json");
    for (const state of [null, "{", JSON.stringify({ version: 99 }),
      JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), builder: "older-builder" })]) {
      if (state === null) unlinkSync(statePath); else writeFileSync(statePath, state);
      const mtime = mark(path);
      writeAskIndex(dir, input);
      assert.equal(readFileSync(path, "utf8"), bytes);
      assert.notEqual(statSync(path).mtimeMs, mtime, "unverified metadata cannot skip generation");
    }
    unlinkSync(statePath);
    mkdirSync(statePath);
    input.nodes[0].body_text = "fresh searchable content";
    assert.doesNotThrow(() => writeAskIndex(dir, input));
    assert.ok(readFileSync(path, "utf8").includes("searchable"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
