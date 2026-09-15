import { performance } from "node:perf_hooks";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Session } from "node:inspector";
import { digest, filesUnder } from "./workload.js";

const [variant, workspace, scenario, output, warmupString = "5", contextOverride] = process.argv.slice(2);
const load = (path: string): Promise<any> => import(pathToFileURL(join(variant, "dist", path)).href);
const graph = JSON.parse(readFileSync(join(workspace, "graph.json"), "utf8"));
const context = contextOverride ?? join(workspace, `context-${process.pid}`);
mkdirSync(context, { recursive: true });
let operation: () => unknown | Promise<unknown>;
let inspect: () => unknown = () => null;
let counts: Record<string, unknown> = { nodes: graph.nodes.length, edges: graph.edges.length };
let warmups = Number(warmupString);

if (scenario === "grep.synthetic") {
  const { grepGraph } = await load("search/grep.js");
  operation = () => grepGraph(graph, join(workspace, "synthetic"), "needle", { maxHits: 400 });
} else if (scenario === "blast.synthetic") {
  const { blastRadius } = await load("blast/blast.js");
  const changed = graph.nodes.filter((n: any) => n.kind === "file").slice(0, 100)
    .map((n: any) => ({ path: n.path, status: "modified", ranges: [{ start: 1, end: 1 }] }));
  operation = () => blastRadius(graph, changed, "benchmark", { depth: 3 });
} else if (scenario === "traverse.loaded") {
  const { writeGraph } = await load("graph/write.js");
  const { loadGraphCached } = await load("graph/load.js");
  const { edgeWalk } = await load("graph/traverse.js");
  writeGraph(graph, context);
  const loaded = loadGraphCached(context);
  const seeds = loaded.nodes.filter((n: any) => n.kind === "function").slice(0, 100);
  operation = () => seeds.map((seed: any) => edgeWalk(loaded, seed, "in", 3));
} else if (scenario === "projections.unchanged") {
  const { writeCards, writeIndex } = await load("graph/cards.js");
  const project = () => { const cards = writeCards(graph, context); writeIndex(context, cards.files); return cards; };
  project();
  operation = project;
  inspect = () => filesUnder(context).filter((p) => p.endsWith(".md")).map((path) => ({ path, hash: digest(readFileSync(join(context, path))) }));
} else if (scenario.startsWith("extract.rust")) {
  const { extractGeneric, warmGenericGrammars } = await load("graph/generic.js");
  await warmGenericGrammars(["rust"]);
  const definitions = scenario.endsWith(".large") ? 6000 : 1200;
  const source = Array.from({ length: definitions }, (_, i) => `fn work${i}() { work${(i + 1) % definitions}(); work${(i + 2) % definitions}(); }`).join("\n");
  operation = () => extractGeneric("large.rs", source, "rust");
  counts = { definitions, references: definitions * 2, sourceBytes: Buffer.byteLength(source) };
} else if (scenario.startsWith("build.real.")) {
  const { buildGraph } = await load("graph/build.js");
  const root = join(workspace, "real");
  if (scenario === "build.real.unchanged" && !contextOverride) await buildGraph(root, { contextDir: context });
  warmups = 0;
  operation = async () => {
    const result = await buildGraph(root, { contextDir: context });
    counts = { files: result.files, parsed: result.parsed, reused: result.reused, nodes: result.nodes, edges: result.edges, errors: result.errors };
    // The comparison contract excludes only per-run absolute output paths.
    const { contextDir: _context, graphPath: _graph, seededFrom: _seed, ...stable } = result;
    return stable;
  };
  inspect = () => filesUnder(context).filter((p) => p.endsWith(".md") || p === ".graph/wiring.json" || p.endsWith("ask-index.json"))
    .map((path) => ({ path, hash: digest(readFileSync(join(context, path))) }));
} else throw new Error(`Unknown scenario ${scenario}`);

try {
  for (let i = 0; i < warmups; i++) await operation();
  const before = new Map(filesUnder(context).map((p) => [p, statSync(join(context, p))]));
  const session = process.env.GRAFT_PERF_PROFILE ? new Session() : null;
  const post = session ? (method: string) => new Promise<object>((resolve, reject) => {
    session.post(method, (error, result) => error ? reject(error) : resolve(result ?? {}));
  }) : null;
  if (session && post) { session.connect(); await post("Profiler.enable"); await post("Profiler.start"); }
  const cpu = process.cpuUsage();
  const resources = process.resourceUsage();
  const start = performance.now();
  const result = await operation();
  const durationMs = performance.now() - start;
  const cpuUsed = process.cpuUsage(cpu);
  const afterResources = process.resourceUsage();
  if (session && post) {
    const capture = await post("Profiler.stop") as { profile: unknown };
    writeFileSync(process.env.GRAFT_PERF_PROFILE!, JSON.stringify(capture.profile));
    session.disconnect();
  }
  if (scenario.startsWith("extract.rust")) {
    const extracted = result as { nodes: Array<{ kind: string }>; rawEdges: Array<{ relation: string }> };
    counts.extractedSymbols = extracted.nodes.filter((node) => node.kind !== "file").length;
    counts.extractedCalls = extracted.rawEdges.filter((edge) => edge.relation === "calls").length;
    if (counts.extractedSymbols !== counts.definitions || counts.extractedCalls !== counts.references) {
      throw new Error(`Rust fixture did not exercise the expected extraction route: ${JSON.stringify(counts)}`);
    }
  }
  const changed = filesUnder(context).filter((p) => {
    const previous = before.get(p), now = statSync(join(context, p));
    return !previous || now.mtimeMs !== previous.mtimeMs || now.ino !== previous.ino;
  });
  counts.projectionFilesReplaced = changed.filter((p) => p.endsWith(".md")).length;
  counts.projectionBytesReplaced = changed.filter((p) => p.endsWith(".md")).reduce((sum, p) => sum + statSync(join(context, p)).size, 0);
  writeFileSync(output, JSON.stringify({ durationMs, profiled: !!session, cpuUserMicros: cpuUsed.user, cpuSystemMicros: cpuUsed.system,
    peakRssBytes: afterResources.maxRSS * 1024, peakRssScope: "benchmark process including setup/warmup; excludes descendant processes (including the Perl worker)",
    fsWriteOperations: afterResources.fsWrite - resources.fsWrite, counts,
    semanticDigest: digest(JSON.stringify({ result, files: inspect() })),
  }));
} finally { if (!contextOverride) rmSync(context, { recursive: true, force: true }); }
