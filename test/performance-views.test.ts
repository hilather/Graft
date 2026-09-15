import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callersOf, edgeWalk } from "../src/graph/traverse.js";
import { graphViews } from "../src/graph/views.js";
import { loadGraphCached, invalidateGraphCaches } from "../src/graph/load.js";
import { writeGraph } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const node = (id: string): NodeV1 => ({ id, name: id, path: `${id}.ts`, kind: "function", span: "L1-L2", signature: null,
  exported: true, origin: "ast", body_hash: id, summary: null, summary_state: "pending", crux: null });
const graph = (): GraphV1 => ({ meta: { version: 1, nodeCount: 2, edgeCount: 4, languages: ["typescript"] }, nodes: [node("a"), node("b")], edges: [
  { source: "b", target: "a", relation: "calls", confidence: "extracted" },
  { source: "b", target: "a", relation: "references", confidence: "extracted" },
  { source: "a", target: "a", relation: "calls", confidence: "extracted" },
  { source: "missing", target: "b", relation: "calls", confidence: "extracted" },
] });

test("views preserve single-hop duplicates/self loops, BFS order and mutable caller graphs", () => {
  const g = graph();
  assert.deepEqual(callersOf(g, g.nodes[0]).map((h) => [h.id, h.relation]), [["b", "calls"], ["b", "references"], ["a", "calls"]]);
  assert.deepEqual(edgeWalk(g, g.nodes[0], "in", 2).map((h) => [h.id, h.depth, h.node?.id ?? null]), [["b", 1, "b"], ["missing", 2, null]]);
  g.nodes.push(node("c"));
  g.edges.unshift({ source: "c", target: "a", relation: "calls", confidence: "extracted" });
  assert.equal(callersOf(g, g.nodes[0])[0].node?.id, "c");
  assert.notStrictEqual(graphViews(g), graphViews(g), "mutable public inputs are prepared per request");
});

test("disk snapshots reuse views across many small repos; replacement and deletion invalidate", () => {
  const root = mkdtempSync(join(tmpdir(), "graft-views-"));
  try {
    const dir = join(root, "primary");
    writeGraph(graph(), dir);
    const first = loadGraphCached(dir)!;
    assert.strictEqual(graphViews(first), graphViews(loadGraphCached(dir)!));
    const changed = graph();
    changed.nodes.push(node("c"));
    writeGraph(changed, dir);
    invalidateGraphCaches(dir);
    const second = loadGraphCached(dir)!;
    assert.notStrictEqual(graphViews(first), graphViews(second));
    assert.equal(graphViews(second).byId.get("c")?.name, "c");
    for (let i = 0; i < 9; i++) {
      const extra = join(root, String(i));
      writeGraph(graph(), extra);
      loadGraphCached(extra);
    }
    assert.strictEqual(loadGraphCached(dir), second, "small repositories must not evict a hot snapshot at nine paths");
    rmSync(dir, { recursive: true });
    assert.equal(loadGraphCached(dir), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
