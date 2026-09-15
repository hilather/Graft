/** Lazily prepared lookup tables. Arrays retain graph encounter order, including
 * duplicate edges. Caller-owned mutable graphs get fresh, request-local views. */
import type { EdgeV1, GraphV1, NodeV1 } from "./types.js";
import { WALK_RELATIONS } from "./relations.js";

export class GraphViews {
  constructor(readonly graph: GraphV1) {}
  private ids?: Map<string, NodeV1>;
  private paths?: Map<string, NodeV1[]>;
  private incoming?: Map<string, EdgeV1[]>;
  private outgoing?: Map<string, EdgeV1[]>;

  get byId(): Map<string, NodeV1> {
    return this.ids ??= new Map(this.graph.nodes.map((node) => [node.id, node]));
  }

  get nodesByPath(): Map<string, NodeV1[]> {
    if (!this.paths) {
      this.paths = new Map();
      for (const node of this.graph.nodes) {
        const group = this.paths.get(node.path);
        if (group) group.push(node);
        else this.paths.set(node.path, [node]);
      }
    }
    return this.paths;
  }

  walkEdges(direction: "in" | "out"): Map<string, EdgeV1[]> {
    const cached = direction === "in" ? this.incoming : this.outgoing;
    if (cached) return cached;
    const adjacency = new Map<string, EdgeV1[]>();
    for (const edge of this.graph.edges) {
      if (!WALK_RELATIONS.has(edge.relation)) continue;
      const key = direction === "in" ? edge.target : edge.source;
      const group = adjacency.get(key);
      if (group) group.push(edge);
      else adjacency.set(key, [edge]);
    }
    if (direction === "in") this.incoming = adjacency;
    else this.outgoing = adjacency;
    return adjacency;
  }
}

const snapshots = new WeakMap<GraphV1, GraphViews>();

/** Only the disk loader opts in: its snapshots are shared and nonmutable. */
export function registerGraphSnapshot(graph: GraphV1): GraphV1 {
  if (!snapshots.has(graph)) snapshots.set(graph, new GraphViews(graph));
  return graph;
}

export function graphViews(graph: GraphV1): GraphViews {
  return snapshots.get(graph) ?? new GraphViews(graph);
}
