/** Inert graph-root-relative configuration and unmerged Perl project boundaries. */
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { contentHash } from "../util/id.js";

export const PERL_CONFIG_FILE = "graft.perl.json";
export const PERL_MARKERS = ["cpanfile", "Makefile.PL", "Build.PL", "META.json", "META.yml", "dist.ini"] as const;
export type PerlFileRule = "perl" | "exclude";

export interface PerlProject {
  /** Empty means the graph root. All paths use POSIX separators. */
  root: string;
  analysisCwd?: string;
  includeRoots: string[];
  /** Explicit runtime absolute prefixes mapped into the visible source tree. */
  pathMappings?: Record<string, string>;
  confidence: "extracted" | "inferred";
  markers: string[];
}

export interface EffectivePerlConfig {
  version: 1;
  projects: PerlProject[];
  files: Record<string, PerlFileRule>;
  /** Configuration plus project marker paths; never reads host @INC. */
  identity: string;
}

export class PerlConfigError extends Error {
  constructor(message: string) { super(`${PERL_CONFIG_FILE}: ${message}`); this.name = "PerlConfigError"; }
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PerlConfigError(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new PerlConfigError(`unknown ${where} key ${JSON.stringify(key)}`);
}

function relativePath(value: unknown, where: string, file = false): string {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\0*?\[\]{}]/.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new PerlConfigError(`${where} must be an exact POSIX path relative to the graph root`);
  }
  const normalized = posix.normalize(value).replace(/\/$/, "");
  if (normalized === ".." || normalized.startsWith("../") || (file && normalized === ".")) {
    throw new PerlConfigError(`${where} must stay inside the graph root${file ? " and name a file" : ""}`);
  }
  return normalized === "." ? "" : normalized;
}

/** JSON.parse discards duplicate object keys. Detect them before accepting rules
 * so escaped or repeated path keys cannot silently replace one another. */
function rejectDuplicateKeys(text: string): void {
  const stack: (Set<string> | null)[] = [];
  const tokens = text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/gs);
  for (const token of tokens) {
    if (token[0] === "{") stack.push(new Set());
    else if (token[0] === "[") stack.push(null);
    else if (token[0] === "}" || token[0] === "]") stack.pop();
    else if (/^\s*:/.test(text.slice(token.index! + token[0].length))) {
      const key = JSON.parse(token[0]) as string;
      const seen = stack.at(-1);
      if (seen?.has(key)) throw new PerlConfigError(`duplicate object key ${JSON.stringify(key)}`);
      seen?.add(key);
    }
  }
}

export function parsePerlConfig(text: string | null, visibleFiles: readonly string[]): EffectivePerlConfig {
  const projects = new Map<string, PerlProject>();
  const markerPaths = visibleFiles.filter((f) => (PERL_MARKERS as readonly string[]).includes(posix.basename(f))).sort();
  for (const file of markerPaths) {
    const dir = posix.dirname(file);
    const root = dir === "." ? "" : dir;
    let project = projects.get(root);
    if (!project) {
      project = { root, includeRoots: [posix.join(root, "lib"), root], confidence: "inferred", markers: [] };
      projects.set(root, project);
    }
    project.markers.push(posix.basename(file));
  }
  const files: Record<string, PerlFileRule> = Object.create(null);
  if (text !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new PerlConfigError("invalid JSON"); }
    rejectDuplicateKeys(text);
    const value = object(parsed, "config");
    keys(value, ["version", "projects", "files"], "config");
    if (value.version !== 1) throw new PerlConfigError("version must be 1");
    if (value.projects !== undefined) {
      if (!Array.isArray(value.projects)) throw new PerlConfigError("projects must be an array");
      const seen = new Set<string>();
      value.projects.forEach((input, index) => {
        const where = `projects[${index}]`;
        const p = object(input, where);
        keys(p, ["root", "analysisCwd", "includeRoots", "pathMappings"], where);
        const root = relativePath(p.root, `${where}.root`);
        if (seen.has(root)) throw new PerlConfigError(`duplicate project root ${JSON.stringify(root || ".")}`);
        seen.add(root);
        if (!Array.isArray(p.includeRoots)) throw new PerlConfigError(`${where}.includeRoots must be an ordered array`);
        const includeRoots = p.includeRoots.map((r, i) => relativePath(r, `${where}.includeRoots[${i}]`));
        if (new Set(includeRoots).size !== includeRoots.length) throw new PerlConfigError(`${where}.includeRoots contains duplicates`);
        const analysisCwd = p.analysisCwd === undefined ? undefined : relativePath(p.analysisCwd, `${where}.analysisCwd`);
        let pathMappings: Record<string, string> | undefined;
        if (p.pathMappings !== undefined) {
          pathMappings = Object.create(null) as Record<string, string>;
          for (const [runtime, source] of Object.entries(object(p.pathMappings, `${where}.pathMappings`))) {
            if (!runtime.startsWith("/") || runtime.includes("\\") || /[\0*?\[\]{}]/.test(runtime)) throw new PerlConfigError(`${where}.pathMappings keys must be exact absolute POSIX paths`);
            const normalized = posix.normalize(runtime).replace(/\/$/, "") || "/";
            if (Object.hasOwn(pathMappings, normalized)) throw new PerlConfigError(`${where}.pathMappings contains duplicate normalized path ${JSON.stringify(normalized)}`);
            pathMappings[normalized] = relativePath(source, `${where}.pathMappings[${JSON.stringify(runtime)}]`);
          }
        }
        projects.set(root, { root, includeRoots, ...(analysisCwd === undefined ? {} : { analysisCwd }), ...(pathMappings ? { pathMappings } : {}), confidence: "extracted", markers: projects.get(root)?.markers ?? [] });
      });
    }
    if (value.files !== undefined) {
      for (const [input, rule] of Object.entries(object(value.files, "files"))) {
        const path = relativePath(input, `files[${JSON.stringify(input)}]`, true);
        if (Object.hasOwn(files, path)) throw new PerlConfigError(`duplicate normalized file path ${JSON.stringify(path)}`);
        if (rule !== "perl" && rule !== "exclude") throw new PerlConfigError(`file rule for ${JSON.stringify(input)} must be "perl" or "exclude"`);
        files[path] = rule;
      }
    }
  }
  const ordered = [...projects.values()].sort((a, b) => b.root.length - a.root.length || a.root.localeCompare(b.root));
  return { version: 1, projects: ordered, files, identity: contentHash(JSON.stringify({ text, markerPaths })) };
}

export function readPerlConfig(root: string, visibleFiles: readonly string[]): EffectivePerlConfig {
  let text: string | null = null;
  try { text = readFileSync(`${root}/${PERL_CONFIG_FILE}`, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new PerlConfigError(`cannot read config: ${(error as Error).message}`); }
  return parsePerlConfig(text, visibleFiles);
}

export function perlProjectOf(file: string, config: EffectivePerlConfig): PerlProject | undefined {
  return config.projects.find((p) => p.root === "" || file.startsWith(`${p.root}/`));
}
