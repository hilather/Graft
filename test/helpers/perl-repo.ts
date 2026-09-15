import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../../src/graph/build.js";
import { readGraph, wiringPath } from "../../src/graph/write.js";
import type { GraphV1, Relation } from "../../src/graph/types.js";

export const exactPerlConfig = { version: 1, projects: [{ root: ".", analysisCwd: ".", includeRoots: ["lib"] }] };
export const utilSource = "package Acme::Util;\nuse strict;\nuse warnings;\nuse Exporter 'import';\nour @EXPORT_OK = qw(normalize);\nsub normalize {\n    my ($value) = @_;\n    return lc $value; # normalize_sentinel_409\n}\n1;\n";
export const runnerSource = "use strict;\nuse warnings;\nuse Acme::Util qw(normalize);\nsub run {\n    return normalize('PAYLOAD');\n}\nrun();\n";

export function perlRepo(files: Record<string, string>, config: unknown = exactPerlConfig) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "graft-perl-resolve-")));
  const out = join(root, "context");
  const write = (file: string, source: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); };
  for (const [file, source] of Object.entries(files)) write(file, source);
  if (config !== null) write("graft.perl.json", JSON.stringify(config));
  return {
    root, out, write,
    build: (reuse = true) => buildGraph(root, { contextDir: out, reuse }),
    graph: () => readGraph(wiringPath(out))!,
    bytes: () => readFileSync(wiringPath(out), "utf8"),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function semanticEdges(graph: GraphV1, relation: Relation = "calls"): string[] {
  return graph.edges.filter((e) => e.relation === relation).map((e) => `${e.source} -> ${e.target} [${e.confidence}]`).sort();
}
