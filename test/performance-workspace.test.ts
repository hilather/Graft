import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGraph } from "../src/graph/write.js";
import { writeAskIndex } from "../src/ask/index-file.js";
import { __parseCount, __resetParseCounts, invalidateGraphCaches, loadGraphCached } from "../src/graph/load.js";
import { federateAsk, writeWorkspace } from "../src/graph/workspace.js";
import { contextDirFor } from "../src/context/node-file.js";
import { ask } from "../src/ask/ask.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

for (const count of [8, 9, 12, 32]) {
  test(`workspace search reuses graph/index snapshots across ${count} children`, () => {
    const root = mkdtempSync(join(tmpdir(), "graft-workspace-cache-"));
    const children = Array.from({ length: count }, (_, i) => `repo${String(i).padStart(2, "0")}`);
    try {
      for (const child of children) {
        const dir = join(root, child);
        mkdirSync(dir);
        writeFileSync(join(dir, "service.ts"), "export function routeHandler() { return 1; }\n");
        const node: NodeV1 = { id: "service.ts#routeHandler", name: "routeHandler", kind: "function", path: "service.ts", span: "L1-L1",
          signature: "function routeHandler()", exported: true, origin: "ast", body_hash: child, summary_state: "pending", summary: null, crux: null };
        const graph: GraphV1 = { meta: { version: 1, nodeCount: 2, edgeCount: 0, languages: ["typescript"] },
          nodes: [{ ...node, id: "service.ts", name: "service.ts", kind: "file" }, node], edges: [] };
        writeGraph(graph, contextDirFor(dir));
        writeAskIndex(contextDirFor(dir), graph);
      }
      writeWorkspace(root, { version: 1, children });
      __resetParseCounts();
      const first = federateAsk(root, undefined, "route handler", { limit: count, source: true });
      assert.ok(first.hits.length > 0);
      assert.deepEqual({ ...__parseCount }, { graph: count, askIndex: count }, "each graph is parsed once within a cold workspace request");
      for (let i = 0; i < 3; i++) {
        __resetParseCounts();
        assert.deepEqual(federateAsk(root, undefined, "route handler", { limit: count, source: true }), first);
        assert.deepEqual({ ...__parseCount }, { graph: 0, askIndex: 0 }, "warm workspace requests must not thrash the caches");
      }
      const childDir = join(root, children[0]);
      const outDir = contextDirFor(childDir);
      const snapshot = loadGraphCached(outDir)!;
      const opts = { source: true, preloadedGraph: snapshot };
      const expected = ask(childDir, "route handler", opts);
      invalidateGraphCaches(outDir);
      __resetParseCounts();
      assert.deepEqual(ask(childDir, "route handler", opts), expected);
      assert.deepEqual({ ...__parseCount }, { graph: 0, askIndex: 1 }, "a request snapshot works after cache eviction without reloading its graph");

      // A later workspace request still observes replaced and removed children.
      const changed = { ...snapshot, nodes: snapshot.nodes.map(node => ({ ...node, name: "replacementHandler", signature: "function replacementHandler()" })) };
      writeGraph(changed, outDir);
      writeAskIndex(outDir, changed);
      invalidateGraphCaches(outDir);
      __resetParseCounts();
      const afterChange = federateAsk(root, undefined, "replacement handler", { limit: count });
      assert.ok(afterChange.hits.some(hit => hit.pointer.startsWith(children[0] + "/") && hit.title.includes("replacementHandler")));
      assert.deepEqual({ ...__parseCount }, { graph: 1, askIndex: 1 });
      rmSync(outDir, { recursive: true });
      const afterDelete = federateAsk(root, undefined, "route handler", { limit: count });
      assert.ok(afterDelete.hits.every(hit => !hit.pointer.startsWith(children[0] + "/")));
    } finally {
      for (const child of children) invalidateGraphCaches(contextDirFor(join(root, child)));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
