import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function filesUnder(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? filesUnder(root, path) : entry.isFile() ? [path] : [];
    });
}

export function manifest(root: string) {
  const files = filesUnder(root).map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path, bytes: bytes.length, sha256: digest(bytes) };
  });
  return { files, sourceFiles: files.length, sourceBytes: files.reduce((sum, file) => sum + file.bytes, 0), sha256: digest(JSON.stringify(files)) };
}

/** Deterministic scale fixture; generation and initial projection writes are
 * outside measured operations. The real corpus is a frozen source snapshot. */
export function prepareWorkloads(root: string, reference: string) {
  const synthetic = join(root, "synthetic");
  const real = join(root, "real");
  mkdirSync(synthetic, { recursive: true });
  mkdirSync(real, { recursive: true });
  const nodes: object[] = [], edges: object[] = [];
  const fileCount = 1500, symbolsPerFile = 8;
  for (let i = 0; i < fileCount; i++) {
    const path = `src/group${i % 20}/file${i}.ts`;
    const base = { path, exported: true, origin: "ast", body_hash: String(i), summary_state: "pending", summary: null, crux: null, language: "typescript" };
    const lines = Array.from({ length: symbolsPerFile }, (_, j) => `export function work${j}() { return "needle ${i}"; }`);
    nodes.push({ ...base, id: path, name: `file${i}.ts`, kind: "file", span: `L1-L${symbolsPerFile}`, signature: null, chars: lines.join("\n").length });
    for (let j = 0; j < symbolsPerFile; j++) {
      const id = `${path}#work${j}`;
      nodes.push({ ...base, id, name: `work${j}`, kind: "function", span: `L${j + 1}-L${j + 1}`, signature: lines[j] });
      edges.push({ source: path, target: id, relation: "contains", confidence: "extracted" });
      const targetFile = (i + 1) % fileCount;
      edges.push({ source: id, target: `src/group${targetFile % 20}/file${targetFile}.ts#work${j}`, relation: "calls", confidence: "extracted" });
    }
    mkdirSync(dirname(join(synthetic, path)), { recursive: true });
    writeFileSync(join(synthetic, path), lines.join("\n"));
  }
  const graph = { meta: { version: 1, nodeCount: nodes.length, edgeCount: edges.length, languages: ["typescript"] }, nodes, edges };
  writeFileSync(join(root, "graph.json"), JSON.stringify(graph));
  // Include existing multilingual fixtures without running or installing them.
  for (const path of ["src", "test", "viewer", "scripts", "package.json"]) cpSync(join(reference, path), join(real, path), { recursive: true });
  const result = {
    synthetic: { ...manifest(synthetic), nodes: nodes.length, edges: edges.length },
    real: manifest(real), graphSha256: digest(JSON.stringify(graph)),
  };
  writeFileSync(join(root, "workloads.json"), JSON.stringify(result, null, 2));
  return result;
}
