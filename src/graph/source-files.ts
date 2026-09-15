/**
 * The file set a graph build parses, and its stat metadata.
 *
 * Split out of `build.ts` so the freshness probe (`fingerprint.ts`) can enumerate
 * exactly the same files without importing the builder (which would be an import
 * cycle: build → fingerprint → build). `build.ts` re-exports
 * {@link listSourceFiles} so its existing importers are unaffected.
 */
import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { canonicalWalkRoot, walkDir } from "../ingest/fs.js";
import { relPosix } from "../util/paths.js";
import { readFollowNestedRepos, readFollowSubmodules, readIncludeDirs } from "../util/state.js";
import { depthExtensions } from "./extract.js";
import { genericExtensions } from "./generic.js";
import { containerExtensions } from "./container.js";
import { classifySource, needsSourcePrefix, PERL_CANDIDATE_EXTENSIONS, SOURCE_PREFIX_BYTES, type SourceClassification } from "./source-classify.js";
import { readPerlConfig, perlProjectOf, type EffectivePerlConfig } from "./perl-config.js";
import { readSourcePrefix } from "../util/source.js";
import { contentHash } from "../util/id.js";
import { PERL_MAX_SOURCE_CODE_UNITS } from "./perl-types.js";

/** Shared structural/deep discovery, including bounded large Perl candidates. */
export function walkSourceTree(root: string): string[] {
  const canonicalRoot = canonicalWalkRoot(root);
  let rules: EffectivePerlConfig["files"] | undefined;
  return walkDir(root, readIncludeDirs(resolve(root)), {
    followSubmodules: readFollowSubmodules(resolve(root)),
    followNestedRepos: readFollowNestedRepos(resolve(root)),
    includeOversizedFile: (absolutePath, bytes) => {
      // UTF-8 needs at most three bytes per UTF-16 code unit, plus a BOM.
      // The parser still enforces the decoded limit after classification.
      if (bytes > PERL_MAX_SOURCE_CODE_UNITS * 3 + 3) return false;
      rules ??= readPerlConfig(root, []).files;
      const rel = relPosix(canonicalRoot, absolutePath);
      return needsSourcePrefix(rel, rules[rel]);
    },
  });
}

/** Every extension graft has a parser for (depth + breadth + container + Perl), sorted
 * and de-duped — the authoritative answer to "what does `-e` actually support". */
export function supportedExtensions(): string[] {
  return [...new Set([...depthExtensions(), ...genericExtensions(), ...containerExtensions(), ...PERL_CANDIDATE_EXTENSIONS])].sort();
}

/** Normalize a user-supplied extension: ensure a leading dot, lower-case. */
function normExt(e: string): string {
  const t = e.trim().toLowerCase();
  return t.startsWith(".") ? t : `.${t}`;
}

/**
 * The subset of user-supplied `-e` extensions that no parser claims (depth or breadth).
 * `graft build -e ".vue"` used to accept these silently and index nothing; the CLI warns
 * on whatever this returns so an unsupported extension is never a quiet no-op.
 */
export function unsupportedExtensions(exts: string[]): string[] {
  const supported = new Set(supportedExtensions());
  return exts.filter((e) => !supported.has(normExt(e)));
}

/**
 * The source files a graph build parses: supported languages, minus the
 * output dir. When no pre-enumerated `repoFiles` is passed, the walk reads
 * `root`'s persisted file-walk choices directly from state, so every caller
 * that enumerates through here (the fingerprint probe and hooks/refresh path,
 * none of which ever see a CLI flag) behaves identically to the build that
 * saved those choices.
 */
/** Keep only files whose repo-relative path is at or under one of `onlyDirs`.
 * No-op when `onlyDirs` is empty/absent. The whitelist is carried in the graph
 * itself (the fingerprint records it at build time), never in the source repo,
 * so a build and the query-path freshness probe read the identical set. */
export function filterByOnlyDirs(
  files: string[],
  root: string,
  onlyDirs?: ReadonlySet<string>,
): string[] {
  if (!onlyDirs || onlyDirs.size === 0) return files;
  return files.filter((abs) => {
    const rel = relPosix(root, abs);
    return [...onlyDirs].some((d) => rel === d || rel.startsWith(`${d}/`));
  });
}

export function listSourceFiles(
  root: string,
  outDir: string,
  repoFiles: string[] = walkSourceTree(root),
  onlyDirs?: ReadonlySet<string>,
): string[] {
  return collectSourceFiles(root, outDir, repoFiles, onlyDirs).files.map((f) => f.abs);
}

export interface SourceStat {
  /** Absolute path. */
  abs: string;
  /** Repo-relative, posix (`relPosix`) — exactly the form `buildGraph` uses for
   * node ids and `checkGraph` diffs against, so cache keys and ids can never
   * disagree. Posix on every platform: see `../util/paths.ts`. */
  rel: string;
  size: number;
  mtimeMs: number;
}

/**
 * {@link listSourceFiles} plus each file's `(size, mtimeMs)` — the currency of
 * both the freshness probe and the extraction cache. Files that vanish between
 * the walk and the stat are dropped (same fail-soft posture as `walkDir`).
 */
export function listSourceStats(
  root: string,
  outDir: string,
  repoFiles?: string[],
  onlyDirs?: ReadonlySet<string>,
): SourceStat[] {
  return collectSourceFiles(root, outDir, repoFiles, onlyDirs).files;
}

export interface SourceSelection {
  files: SourceStat[];
  classifications: Map<string, SourceClassification>;
  /** Reading an input needed for classification failed; never a clean exclusion. */
  readErrors: Map<string, string>;
  perlConfig: EffectivePerlConfig;
  analysisIdentity: string;
}

/** Build/check/refresh share this snapshot. Retain classification inputs even
 * for excluded candidates, so an unindexed script gaining a shebang is visible. */
export function collectSourceFiles(
  root: string,
  outDir: string,
  repoFiles: string[] = walkSourceTree(root),
  onlyDirs?: ReadonlySet<string>,
): SourceSelection {
  const visible = repoFiles.filter((f) => f !== outDir && !f.startsWith(`${outDir}${sep}`));
  const perlConfig = readPerlConfig(root, visible.map((f) => relPosix(root, f)));
  const includes = readIncludeDirs(root);
  const files: SourceStat[] = [];
  const classifications = new Map<string, SourceClassification>();
  const readErrors = new Map<string, string>();
  const candidates: [string, string, string][] = [];
  for (const abs of filterByOnlyDirs(visible, root, onlyDirs)) {
    const rel = relPosix(root, abs);
    let s: { size: number; mtimeMs: number };
    try { s = statSync(abs); } catch { continue; }
    const rule = perlConfig.files[rel];
    let prefix: string | null = "";
    if (needsSourcePrefix(rel, rule)) {
      try { prefix = readSourcePrefix(abs, SOURCE_PREFIX_BYTES); } catch (error) { prefix = null; readErrors.set(rel, error instanceof Error ? error.message : String(error)); }
      candidates.push([rel, prefix === null ? "unreadable" : contentHash(prefix), rule ?? ""]);
    }
    const classification = prefix === null && !readErrors.has(rel) ? null : classifySource(rel, prefix ?? "", { rule, project: perlProjectOf(rel, perlConfig), includeGenerated: rel.split("/").some((part) => (part === "blib" || part === "_Inline") && includes?.has(part)) });
    if (!classification) continue;
    classifications.set(rel, classification);
    files.push({ abs, rel, size: s.size, mtimeMs: s.mtimeMs });
  }
  candidates.sort(([a], [b]) => a.localeCompare(b));
  return { files, classifications, readErrors, perlConfig, analysisIdentity: contentHash(JSON.stringify({ config: perlConfig.identity, candidates })) };
}
