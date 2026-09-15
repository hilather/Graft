import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

test("card generation accepts valid long ASCII and multibyte source filenames", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-long-card-"));
  try {
    for (const path of ["a".repeat(220) + ".ts", "é".repeat(110) + ".ts"]) {
      assert.equal(Buffer.byteLength(path), 223);
      const graph: GraphV1 = { meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ["typescript"] }, edges: [], nodes: [{
        id: `${path}#work`, name: "work", path, kind: "function", span: "L1-L1", signature: "function work()",
        exported: true, origin: "ast", body_hash: "a", summary_state: "pending", summary: null, crux: null,
      }] };
      const cards = writeCards(graph, dir);
      assert.equal(cards.written, 1);
      const card = join(dir, cards.files[0].card);
      assert.match(readFileSync(card, "utf8"), /L1-L1/);
      graph.nodes[0].summary = "Changed description";
      writeCards(graph, dir);
      assert.match(readFileSync(card, "utf8"), /Changed description/);
    }
    assert.ok(readdirSync(dir).every(name => !name.endsWith(".tmp")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("INDEX writes preserve dangling symlinks and follow their intended destinations", { skip: process.platform === "win32" ? "symlink privileges vary on Windows" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-dangling-index-"));
  try {
    const out = join(dir, "graft"), targets = join(dir, "targets");
    mkdirSync(out); mkdirSync(targets);
    const link = join(out, "INDEX.md");
    for (const destination of [join(targets, "absolute.md"), "../targets/relative.md", "../targets/chain.md"]) {
      const target = destination.includes("chain") ? join(targets, "chained.md")
        : destination.startsWith("..") ? join(targets, "relative.md") : destination;
      if (destination.includes("chain")) symlinkSync("chained.md", join(targets, "chain.md"));
      symlinkSync(destination, link);
      writeIndex(out, []);
      assert.equal(lstatSync(link).isSymbolicLink(), true);
      assert.equal(readlinkSync(link), destination);
      assert.match(readFileSync(target, "utf8"), /# graft/);
      if (destination.includes("chain")) assert.equal(lstatSync(join(targets, "chain.md")).isSymbolicLink(), true);
      const before = statSync(target).mtimeMs;
      const writes = { written: 0, skipped: 0, bytesWritten: 0 };
      writeIndex(out, [], writes);
      assert.equal(writes.skipped, 1);
      assert.equal(statSync(target).mtimeMs, before);
      rmSync(link);
    }
    // Resolve parent symlinks before interpreting '..' in a link destination.
    mkdirSync(join(targets, "nested"));
    symlinkSync(join(targets, "nested"), join(out, "alias"));
    symlinkSync("alias/../parent.md", link);
    writeIndex(out, []);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.match(readFileSync(join(targets, "parent.md"), "utf8"), /# graft/);
    assert.equal(existsSync(join(out, "parent.md")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dangling links with missing parents and symlink cycles fail without replacing links", { skip: process.platform === "win32" ? "symlink privileges vary on Windows" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-bad-index-link-"));
  try {
    const link = join(dir, "INDEX.md");
    symlinkSync("absent/target.md", link);
    assert.throws(() => writeIndex(dir, []), { code: "ENOENT" });
    assert.equal(readlinkSync(link), "absent/target.md");
    rmSync(link);
    symlinkSync("other.md", link);
    symlinkSync("INDEX.md", join(dir, "other.md"));
    assert.throws(() => writeIndex(dir, []), { code: "ELOOP" });
    assert.equal(readlinkSync(link), "other.md");
    assert.equal(readlinkSync(join(dir, "other.md")), "INDEX.md");
    assert.ok(readdirSync(dir).every(name => !name.endsWith(".tmp")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
