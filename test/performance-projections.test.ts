import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCards, writeCovers, writeIndex } from "../src/graph/cards.js";
import type { GraphV1 } from "../src/graph/types.js";
import { writeProjection } from "../src/util/projection.js";
import { chmodDenialUnavailable } from "./helpers.js";

test("unchanged projections preserve bytes/mtime and public counts; edits, deletion and corruption are repaired", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-projections-"));
  const graph: GraphV1 = { meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ["typescript"] }, edges: [], nodes: [{
    id: "src/a.ts#work", name: "work", path: "src/a.ts", kind: "function", span: "L1-L2", signature: "function work()",
    exported: true, origin: "ast", body_hash: "a", summary_state: "pending", summary: null, crux: null,
  }] };
  try {
    const concept = join(dir, "concept.md");
    writeFileSync(concept, "---\nslug: concept\nname: Concept\nsources:\n  - path: src/a.ts\n---\nHuman notes.\n");
    const cards = writeCards(graph, dir);
    writeIndex(dir, cards.files);
    assert.equal(writeCovers(graph, dir), 1);
    const paths = [join(dir, cards.files[0].card), join(dir, "INDEX.md"), concept];
    const bytes = paths.map((path) => readFileSync(path));
    const old = new Date("2000-01-01T00:00:00Z");
    for (const path of paths) utimesSync(path, old, old);
    const writes = { written: 0, skipped: 0, bytesWritten: 0 };
    assert.deepEqual(writeCards(graph, dir, writes), cards);
    writeIndex(dir, cards.files, writes);
    assert.equal(writeCovers(graph, dir, writes), 1);
    assert.deepEqual(writes, { written: 0, skipped: 3, bytesWritten: 0 });
    paths.forEach((path, i) => { assert.deepEqual(readFileSync(path), bytes[i]); assert.equal(statSync(path).mtimeMs, old.getTime()); });
    writeFileSync(paths[0], bytes[0].toString().replace("function work()", "function bad!()"));
    utimesSync(paths[0], old, old);
    writeCards(graph, dir);
    assert.deepEqual(readFileSync(paths[0]), bytes[0]);
    rmSync(paths[0]);
    writeCards(graph, dir);
    assert.deepEqual(readFileSync(paths[0]), bytes[0]);
    graph.nodes[0].summary = "Updated summary";
    writeCards(graph, dir);
    assert.match(readFileSync(paths[0], "utf8"), /Updated summary/);
    assert.equal(writeCards({ ...graph, nodes: [] }, dir).pruned, 1);
    assert.match(readFileSync(concept, "utf8"), /Human notes/);
    assert.ok(readdirSync(dir).every((name) => !name.endsWith(".tmp")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("atomic projection replacement preserves modes and symlink destinations", { skip: process.platform === "win32" ? "symlink privileges vary on Windows" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-projection-link-"));
  try {
    const target = join(dir, "target.md"), link = join(dir, "link.md");
    writeFileSync(target, "before");
    chmodSync(target, 0o664);
    symlinkSync(target, link);
    writeProjection(link, "after");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(target, "utf8"), "after");
    assert.equal(statSync(target).mode & 0o777, 0o664);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("projection write failures preserve existing bytes and propagate permission errors", (t) => {
  const unavailable = chmodDenialUnavailable();
  if (unavailable) { t.skip(unavailable); return; }
  const dir = mkdtempSync(join(tmpdir(), "graft-projection-denied-")), path = join(dir, "card.md");
  try {
    writeFileSync(path, "before");
    chmodSync(path, 0o444);
    assert.throws(() => writeProjection(path, "after"), { code: "EACCES" });
    assert.equal(readFileSync(path, "utf8"), "before");
    chmodSync(path, 0o644);
    chmodSync(dir, 0o500);
    assert.throws(() => writeProjection(path, "after"), { code: "EACCES" });
    assert.equal(readFileSync(path, "utf8"), "before");
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});
