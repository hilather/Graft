/**
 * `graph` — build `.context/graph.json` from a code repository.
 *
 * M1 pipeline (Tier-1 only, deterministic, no LLM):
 *   1. Walk the repo for TS/Python source files.
 *   2. Parse each with tree-sitter and emit one NodeV1 per definition.
 *   3. Write a sorted graph.json.
 * Edges (M2) and LLM summary/crux (M3) layer onto this without changing it.
 *
 * Step 2 is memoized per file (`extract-cache.ts`): a file whose bytes haven't
 * moved replays its last parse instead of re-running tree-sitter, so a rebuild
 * costs ~the files that changed. Everything after extraction still runs over the
 * whole node set, so an incremental build's output is byte-identical to a cold
 * one — the invariant `test/graph-incremental.test.ts` pins down.
 */
import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { contextDirFor, ensureGitignored, ensureSearchable, CACHE_DIR } from "../context/node-file.js";
import type { RawEdge } from "./extract.js";
import { SourceDispatcher } from "./source-dispatch.js";
import type { PerlParserOptions } from "./perl-parser.js";
import { buildPerlModuleEnvironment } from "./perl-modules.js";
import { resolvePerlEdges } from "./perl-resolve.js";
import { materializePerlFrameworks } from "./perl-frameworks.js";
import { perlFileResult } from "./perl-extract.js";
import { contentHash } from "../util/id.js";
import { relPosix } from "../util/paths.js";
import { readSourceFile } from "../util/source.js";
import { writeJsonAtomic } from "../util/state.js";
import {
  emptyExtractCache,
  readExtractCache,
  writeExtractCache,
  type ExtractEntry,
} from "./extract-cache.js";
import { writeFingerprint } from "./fingerprint.js";
import { seedGraph, type SeedResult } from "./seed.js";
import { filterByOnlyDirs, collectSourceFiles, walkSourceTree } from "./source-files.js";
import { resolveEdges, type GoModule } from "./resolve.js";
import { enrichGraph, type EnrichStats } from "./enrich.js";
import { readGraph, writeGraph, wiringPath } from "./write.js";
import { writeCards, writeIndex, writeCovers, type CardStats } from "./cards.js";
import { writeAskIndex } from "../ask/index-file.js";
import { discoverScopes, scopeOf } from "./scopes.js";
import type { GraphV1, Kind, NodeV1, Relation, ScopeV1 } from "./types.js";
import type { CruxSummarizer } from "../ai/crux.js";

export { listSourceFiles } from "./source-files.js";

/** Minimum non-file node count for a discovered sub-scope to stand on its own
 * (over-split guard 3). A scope with fewer nodes than this is folded into the
 * root scope — node counts aren't known until after the graph is assembled,
 * so this runs here rather than in `discoverScopes`. */
const MIN_SCOPE_NODES = 5;

/** Guard 5: merge scopes with too few non-file nodes into the root scope, then
 * re-apply the canonical single-scope collapse (rule 6) if only root is left. */
function applyMinSubstanceGuard(scopes: ScopeV1[], nodes: NodeV1[]): ScopeV1[] {
  if (scopes.length <= 1) return scopes;
  const counts = new Map<string, number>();
  for (const scope of scopes) counts.set(scope.prefix, 0);
  for (const node of nodes) {
    if (node.kind === "file") continue;
    const scope = scopeOf(node.path, scopes);
    counts.set(scope.prefix, (counts.get(scope.prefix) ?? 0) + 1);
  }
  const kept = scopes.filter((s) => s.prefix === "" || (counts.get(s.prefix) ?? 0) >= MIN_SCOPE_NODES);
  if (kept.length === 0) return [{ prefix: "", label: "", markers: [] }];
  if (kept.length === 1 && kept[0].prefix === "") {
    return [{ prefix: "", label: "", markers: kept[0].markers }];
  }
  return kept;
}

export interface GraphBuildOptions {
  /** Internal parser lifecycle seam; not exposed as a CLI option. */
  perlParser?: PerlParserOptions;
  /** Override the output dir (default: `<root>/.context`). */
  contextDir?: string;
  /** Replay unchanged files from the extraction cache instead of re-parsing them
   * (default true). False forces a cold parse of the whole repo. */
  reuse?: boolean;
  /** Write only what a query reads — the graph, the `ask` sidecar, the freshness
   * record — and skip the markdown projections and the `.gitignore` touch. Set by
   * the pre-query refresh (`graph/refresh.ts`); an explicit `graft build` never
   * sets it. See the write block in {@link buildGraph} for why the split exists. */
  graphOnly?: boolean;
  /** Opt-in compiler-grade edge enrichment via a language server (`graft build
   * --lsp`): adds `lsp_resolved` call edges the AST resolver couldn't (member
   * calls, breadth-tier calls). Off by default — needs a server on PATH and is
   * slower; the graph is fully functional without it. */
  lsp?: boolean;
  /** Run the Tier-2 LLM meaning pass. Absent → Tier-1 only (cache is still preserved). */
  summarizer?: CruxSummarizer;
  /** Max files summarized in parallel during the Tier-2 pass. Default is set in enrich. */
  concurrency?: number;
  /** Repo-relative directory prefixes to limit the build to (`--only-dir`). When
   * set, only files under these prefixes are indexed; the list is recorded in the
   * fingerprint so the freshness probe enumerates the same set. */
  onlyDirs?: string[];
  onProgress?: (info: {
    phase: "parse" | "enrich";
    index: number;
    total: number;
    file: string;
  }) => void;
}

export interface GraphBuildResult {
  perl?: { files: number; partial: number; failed: number; diagnostics: number; workerStarts: number };
  contextDir: string;
  graphPath: string;
  /** Per-file wiring cards written (Tier-2 passive surface). */
  cards: number;
  files: number;
  /** Files re-parsed this run (the rest were replayed from the extraction cache). */
  parsed: number;
  /** Files replayed from the extraction cache. */
  reused: number;
  /** The parent checkout this build copied a starting graph from, when it was run in
   * a git worktree that had none of its own. See `./seed.ts`. */
  seededFrom?: string;
  nodes: number;
  edges: number;
  byKind: Record<Kind, number>;
  byRelation: Record<Relation, number>;
  languages: string[];
  meaning: EnrichStats;
  errors: string[];
}

/** Every Go module in the repo: each `go.mod`'s declared `module` path and the repo
 * directory it lives in (posix, `.` for the root). Found anywhere in the tree, so a
 * monorepo whose module is in a subdir (e.g. `backend/go.mod`) resolves too. Lets edge
 * resolution map Go import paths to in-repo files.
 *
 * `repoFiles` is buildGraph's single enumeration, which already carries root's
 * persisted `--include-dir` override — so a `go.mod` living under an included
 * dir (e.g. `build/go.mod`) is found here exactly when its `.go` files are
 * indexed, and its intra-module imports resolve. */
function readGoModules(root: string, repoFiles: string[]): GoModule[] {
  const mods: GoModule[] = [];
  for (const f of repoFiles) {
    if (basename(f) !== "go.mod") continue;
    try {
      const m = readFileSync(f, "utf8").match(/^\s*module\s+(\S+)/m);
      if (!m) continue;
      const rel = relPosix(root, dirname(f));
      mods.push({ module: m[1], dir: rel === "" ? "." : rel });
    } catch {
      /* unreadable go.mod — skip this module */
    }
  }
  return mods;
}

export async function buildGraph(
  dir: string,
  opts: GraphBuildOptions = {},
): Promise<GraphBuildResult> {
  const root = resolve(dir);
  const outDir = contextDirFor(root, opts.contextDir);
  // Enumerate once: source extraction, scope discovery, and Go module
  // resolution must agree on the same Git-ignore-aware working-tree view —
  // including the repo's persisted directory and submodule choices.
  const walked = walkSourceTree(root);
  const onlyDirs = opts.onlyDirs && opts.onlyDirs.length > 0 ? new Set(opts.onlyDirs) : undefined;
  const repoFiles = filterByOnlyDirs(walked, root, onlyDirs);
  const selection = collectSourceFiles(root, outDir, walked, onlyDirs);
  const files = selection.files;
  const discoveredScopes = discoverScopes(root, repoFiles);

  const nodes: NodeV1[] = [];
  const rawEdges: RawEdge[] = [];
  const sources = new Map<string, string>();
  /** Display labels, not grammars — `.mjs` is parsed as typescript but reported as
   * javascript, or the banner claims a repo's JavaScript went unindexed. */
  const langs = new Set<string>();
  const errors: string[] = [];
  for (const [file, message] of selection.readErrors) if (!selection.classifications.has(file)) errors.push(`${file}: SOURCE_CLASSIFICATION_UNAVAILABLE: ${message}`);

  // In a git worktree there is nothing to reuse *yet* — `graft/` is gitignored, so
  // git never checked it out — but the parent checkout's graph is one directory away.
  // Copy it in before reading the priors below and this build is incremental and
  // keeps its paid-for summaries, instead of being a cold parse of the whole repo.
  // No-ops everywhere else, including on an explicit cold build (`reuse: false`).
  const seed: SeedResult =
    opts.reuse === false ? { seeded: false } : seedGraph(root, { contextDir: opts.contextDir });

  // Tier-1 memo: unchanged files replay their last parse. `entries` is rebuilt
  // from scratch each run and keyed only by files currently on disk, so deletions
  // fall out of both the cache and the fingerprint with no separate pruning pass.
  const priorExtract = opts.reuse === false ? emptyExtractCache() : readExtractCache(outDir);
  const entries: Record<string, ExtractEntry> = {};
  let parsed = 0;
  let reused = 0;

  const dispatcher = new SourceDispatcher(opts.perlParser);
  const perlEntries: Record<string, ExtractEntry> = Object.create(null);
  const recordPerl = (rel: string, entry: ExtractEntry): void => {
    if (!entry.languageData) return;
    perlEntries[rel] = entry;
  };
  try {
    await dispatcher.warm(selection.classifications.values());
    for (const [i, f] of files.entries()) {
      const rel = f.rel;
      opts.onProgress?.({ phase: "parse", index: i, total: files.length, file: rel });
      const classification = selection.classifications.get(rel)!;
      const classificationKey = `${classification.kind}:${classification.language}:${classification.kind === "perl" ? classification.mode : ""}`;
      const unavailable = (message: string) => {
        if (classification.kind !== "perl") {
          errors.push(rel + ": " + message);
          entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [], error: message, cacheable: false };
          return;
        }
        const failure = perlFileResult(rel, "", [{ file: rel, code: "PERL_SOURCE_READ_FAILED", severity: "error", message }], "failed", false);
        const entry = entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", classification: classificationKey, ...failure };
        nodes.push(...failure.nodes); langs.add("perl"); recordPerl(rel, entry);
      };
      const selectionError = selection.readErrors.get(rel);
      if (selectionError) { unavailable(selectionError); continue; }
      const cached = priorExtract.files[rel];
      // Always read/hash during a build; only parsing is memoized.
      let source: string | null;
      try {
        source = readSourceFile(f.abs);
      } catch (err) {
        unavailable(err instanceof Error ? err.message : String(err));
        continue;
      }
      if (source === null) {
        entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [] };
        continue;
      }
      const hash = contentHash(source);
      if (cached && hash === cached.hash && cached.classification === classificationKey && cached.cacheable !== false) {
        const entry = entries[rel] = { ...cached, size: f.size, mtimeMs: f.mtimeMs };
        sources.set(rel, source);
        reused++;
        if (cached.error) {
          errors.push(cached.error);
          if (!cached.languageData) continue;
        }
        nodes.push(...cached.nodes);
        rawEdges.push(...cached.rawEdges);
        langs.add(classification.language);
        recordPerl(rel, entry);
        continue;
      }
      parsed++;
      try {
        const extraction = dispatcher.extract(rel, source, classification);
        const extracted = extraction instanceof Promise ? await extraction : extraction;
        nodes.push(...extracted.nodes);
        rawEdges.push(...extracted.rawEdges);
        sources.set(rel, source);
        langs.add(classification.language);
        const entry = entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash, classification: classificationKey, ...extracted };
        recordPerl(rel, entry);
      } catch (err) {
        const message = rel + ": parse failed — " + (err instanceof Error ? err.message : String(err));
        errors.push(message);
        entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash, classification: classificationKey, nodes: [], rawEdges: [], error: message };
      }
    }
  } finally {
    await dispatcher.dispose();
  }
  // Persist the memo BEFORE enrichment, because `enrichGraph` mutates these very
  // node objects (summary/crux/summary_state) and the cache must only ever hold
  // pristine Tier-1 output — otherwise a replayed node would arrive pre-enriched
  // and a cold build and an incremental build could disagree. The meaning layer
  // has its own cache (wiring.json itself, keyed on body_hash); this one is
  // strictly about not re-parsing.
  // Every reused entry has already passed a fresh source hash/classification
  // check. If the roster and stats also match, the existing raw memo is exactly
  // what we would serialize. Keep it on disk before enrichment mutates nodes.
  const unchangedExtract = files.length > 0 && reused === files.length
    && Object.keys(priorExtract.files).length === files.length
    && files.every((file) => priorExtract.files[file.rel].size === file.size
      && priorExtract.files[file.rel].mtimeMs === file.mtimeMs);
  writeExtractCache(outDir, {
    ...emptyExtractCache(),
    files: entries,
  }, unchangedExtract);

  const perlFacts = new Map(Object.entries(perlEntries).map(([file, entry]) => [file, entry.languageData!]));
  const perlEnvironment = buildPerlModuleEnvironment(perlFacts, selection.perlConfig, root);
  const frameworks = materializePerlFrameworks(perlFacts, perlEnvironment);
  nodes.push(...frameworks.nodes); rawEdges.push(...frameworks.rawEdges);
  const edges = resolveEdges(nodes, rawEdges, { goModules: readGoModules(root, repoFiles) });
  const perlResolution = resolvePerlEdges(nodes, frameworks.files, perlEnvironment);
  perlResolution.diagnostics.push(...frameworks.diagnostics);
  edges.push(...perlResolution.edges);
  const resolutionDiagnosticsByFile = new Map<string, typeof perlResolution.diagnostics>();
  for (const diagnostic of perlResolution.diagnostics) {
    const diagnostics = resolutionDiagnosticsByFile.get(diagnostic.file) ?? [];
    diagnostics.push(diagnostic);
    resolutionDiagnosticsByFile.set(diagnostic.file, diagnostics);
  }
  const perlDiagnostics = Object.fromEntries(Object.entries(perlEntries).map(([file, entry]) => {
    const diagnostics = [...entry.languageData!.diagnostics, ...resolutionDiagnosticsByFile.get(file) ?? []];
    if (diagnostics.length) errors.push(file + ": " + diagnostics.slice(0, 3).map((d) => d.code + ": " + d.message).join("; "));
    return [file, { status: entry.status === "failed" ? "failed" : diagnostics.length ? "partial" : "ok", diagnostics }];
  }));
  try {
    const path = join(outDir, CACHE_DIR, "perl-diagnostics.json");
    if (Object.keys(perlDiagnostics).length) writeJsonAtomic(path, { version: 1, files: perlDiagnostics }, true);
    else rmSync(path, { force: true });
  } catch { /* regenerable diagnostics; extraction errors are still in the result */ }

  // Guard 5 (minimum-substance): node counts aren't known until nodes are
  // assembled, so the merge-tiny-scopes-into-root guard runs here.
  const scopes = applyMinSubstanceGuard(discoveredScopes, nodes);

  // Assemble the graph BEFORE the meaning pass, so the crux pass can checkpoint it to
  // disk periodically (#128): crux/summary mutate node objects in place and never
  // change the node/edge SET, so `meta` stays valid; the opt-in LSP pass below is the
  // only thing that adds edges, and it runs before the final write.
  const graph: GraphV1 = {
    meta: {
      version: 1,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      languages: [...langs].sort(),
      scopes,
    },
    nodes,
    edges,
  };

  // graph.json is its own Tier-2 cache: fold in the prior meaning layer so an
  // unchanged body is never re-summarized (and a Tier-1-only run never wipes it).
  // Read BEFORE the first checkpoint can overwrite wiring.json.
  const prior = readGraph(wiringPath(outDir));
  const priorById = new Map((prior?.nodes ?? []).map((n) => [n.id, n]));
  const meaning = await enrichGraph(nodes, priorById, sources, {
    summarizer: opts.summarizer,
    concurrency: opts.concurrency,
    onProgress: ({ index, total, node }) =>
      opts.onProgress?.({ phase: "enrich", index, total, file: node }),
    // Periodic durability flush of partial crux; the next run folds it back in by
    // body_hash, so an interrupted --deep run never repays the crux it computed.
    checkpoint: () => writeGraph(graph, outDir),
  });
  errors.push(...meaning.errors);

  // Opt-in compiler-grade enrichment (adds lsp_resolved call edges in place).
  // Runs on the assembled graph so callee positions map back to nodes; never
  // touches the extraction cache (Tier-1 stays pristine, cold==incremental).
  if (opts.lsp) {
    const { enrichWithLsp } = await import("./lsp/enrich.js");
    const r = await enrichWithLsp(graph, root);
    graph.meta.edgeCount = graph.edges.length;
    opts.onProgress?.({ phase: "enrich", index: r.added, total: r.queried, file: `lsp:${r.server ?? "none"}` });
  }

  const graphPath = writeGraph(graph, outDir);
  // `ask`'s token/IDF sidecar — moves per-query corpus tokenization to build
  // time (~45% of query time on a 32k-node graph, profiled). Lives in the
  // cache dir; `ask` falls back to live tokenization when it's absent/stale.
  // Best-effort: wiring.json is already on disk at this point, so a sidecar
  // write failure (e.g. an unwritable cache dir) must not abort cards/index/
  // covers below — record it and keep going, same as other recoverable errors.
  //
  // MUST pass the in-memory `graph` here, never a re-read of wiringPath(outDir):
  // `writeGraph` strips `body_text` from what it serializes (dead weight once
  // this sidecar exists), so the nodes on disk no longer carry it — only this
  // in-memory object, still holding what `extractFile` populated, does.
  try {
    writeAskIndex(outDir, graph);
  } catch (err) {
    errors.push(`ask-index: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The fingerprint claims exactly one thing: "the graph on disk was built from
  // these source bytes." Nothing about the projections below — which is why it is
  // safe to write here, and why `graphOnly` builds (the query path, which stops
  // right after this line) are still recorded as fresh.
  writeFingerprint(outDir, entries, opts.onlyDirs, selection.analysisIdentity);

  // Tier-2 passive surface: project the nodes into per-file markdown cards, and
  // refresh the INDEX roster. Pure projection — no LLM, no network.
  //
  // Skipped entirely on the query path (`graphOnly`). Retrieval answers from
  // wiring.json and the ask sidecar; the markdown surface is for humans and for
  // the agent's own greps, and it is rebuilt by an explicit `graft build` — which
  // is what the Claude Code `Stop` hook already runs at the end of a turn. Keeping
  // it off the query path is what makes a refresh cheap, leaves the repo untouched
  // (`ensureGitignored` writes `.gitignore`, which a read has no business doing),
  // and means a failure here can never be triggered by a query.
  let cardStats: CardStats = { written: 0, pruned: 0, files: [] };
  if (!opts.graphOnly) {
    // The graph is a local, regenerable cache — make sure git ignores it. Cheap and
    // idempotent, so a fresh clone's first build self-ignores.
    ensureGitignored(root, outDir);
    // …and that gitignoring it doesn't hide the cards from search: ripgrep honours
    // .gitignore, so without this the cards can never be grepped, which is the one
    // way an agent was supposed to stumble onto them.
    ensureSearchable(root, outDir);
    cardStats = writeCards(graph, outDir);
    writeIndex(outDir, cardStats.files);
    // Backfill concept nodes with their `covers:` symbol/file:line list (the
    // OKF↔Wiring link). No-op when there are no concept nodes (a $0 build).
    writeCovers(graph, outDir);
  }

  const byKind = {} as Record<Kind, number>;
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  const byRelation = {} as Record<Relation, number>;
  for (const e of edges) byRelation[e.relation] = (byRelation[e.relation] ?? 0) + 1;

  return {
    ...(Object.keys(perlEntries).length ? { perl: {
      files: Object.keys(perlEntries).length,
      partial: Object.values(perlDiagnostics).filter((e) => e.status === "partial").length,
      failed: Object.values(perlDiagnostics).filter((e) => e.status === "failed").length,
      diagnostics: Object.values(perlDiagnostics).reduce((n, e) => n + e.diagnostics.length, 0),
      workerStarts: dispatcher.perlWorkerStarts,
    } } : {}),
    contextDir: outDir,
    graphPath,
    cards: cardStats.written,
    files: files.length,
    parsed,
    reused,
    seededFrom: seed.from,
    nodes: nodes.length,
    edges: edges.length,
    byKind,
    byRelation,
    languages: [...langs].sort(),
    meaning,
    errors,
  };
}
