/** Shared pure source classification. Discovery supplies only a bounded, decoded
 * prefix and the owning distribution; this module never reads or executes code. */
import { posix } from "node:path";
import { languageOf, languageLabelOf, type Language } from "./extract.js";
import { genericLangOf } from "./generic.js";
import { containerLangOf } from "./container.js";
import type { PerlFileRule, PerlProject } from "./perl-config.js";

export const SOURCE_PREFIX_BYTES = 8_192;
export const PERL_CANDIDATE_EXTENSIONS = [".pm", ".pl", ".t", ".psgi", ".cgi", ".pod"] as const;
const PERL_BASENAMES = new Set(["Makefile.PL", "Build.PL", "cpanfile"]);
const SOURCE_METADATA = new Set([".gitignore", ".ignore", ".gitattributes", ".gitmodules"]);
export type SourceClassification =
  | { kind: "native"; language: string; native: Language; reason: "extension" }
  | { kind: "container" | "generic"; language: string; reason: "extension" }
  | { kind: "perl"; language: "perl"; mode: "source" | "pod"; reason: "explicit" | "extension" | "basename" | "shebang" | "tokens" | "project" };

export interface SourceHints {
  rule?: PerlFileRule;
  project?: PerlProject;
  /** Exact rule or the existing persisted --include-dir can admit generated Perl. */
  includeGenerated?: boolean;
}

/** A small argument lexer for shebang interpreter identity, not a shell parser.
 * No expansion, command substitutions, or execution is performed. */
function words(text: string): string[] | null {
  const result: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"') { if (++i >= text.length) return null; word += text[i]; }
      else word += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === "\\") { if (++i >= text.length) return null; word += text[i]; started = true; }
    else if (/\s/.test(char)) { if (started) { result.push(word); word = ""; started = false; } }
    else { word += char; started = true; }
  }
  if (quote) return null;
  if (started) result.push(word);
  return result;
}

export function hasPerlShebang(prefix: string, depth = 0): boolean {
  if (depth > 8) return false;
  const first = prefix.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  if (!first.startsWith("#!")) return false;
  const args = words(first.slice(2).trim());
  if (!args?.length) return false;
  const isPerl = (name: string) => /^perl(?:5(?:\.\d+){1,2})?$/.test(posix.basename(name));
  if (posix.basename(args[0]) !== "env") return isPerl(args[0]);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-S" || arg === "--split-string") {
      // env -S 'perl -w' and env -S perl -w both split into argv; only the
      // command token is relevant, never a substring of an option or value.
      const split = words(args.slice(i + 1).join(" "));
      return split?.length ? hasPerlShebang(`#!/usr/bin/env ${split.join(" ")}`, depth + 1) : false;
    }
    if (arg.startsWith("--split-string=")) {
      const split = words(arg.slice("--split-string=".length));
      return split?.length ? hasPerlShebang(`#!/usr/bin/env ${split.join(" ")}`, depth + 1) : false;
    }
    if (arg === "-i" || arg === "--ignore-environment") continue;
    if (arg === "-u" || arg === "--unset") { if (!args[++i]) return false; continue; }
    if (/^--unset=.+/.test(arg) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    if (arg === "--") return !!args[i + 1] && isPerl(args[i + 1]);
    if (arg.startsWith("-")) return false;
    return isPerl(arg);
  }
  return false;
}

/** Inspect only the first executable statement after comments/POD. We do not
 * scan past an unknown quote/regex/heredoc looking for token-like substrings.
 * Files with an ambiguous first statement can use a project hint/exact rule. */
function firstCode(prefix: string): string {
  const lines = prefix.replace(/^\uFEFF/, "").split(/\r?\n/);
  let pod = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^=cut(?:\s|$)/.test(line)) { pod = false; continue; }
    if (pod) continue;
    if (/^=[A-Za-z]/.test(line)) { pod = true; continue; }
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (/^__(?:DATA|END)__\b/.test(line)) return "";
    return lines.slice(i).join("\n").trimStart();
  }
  return "";
}

const NAME = String.raw`[\p{L}_][\p{L}\p{N}_]*(?:::[\p{L}_][\p{L}\p{N}_]*)*`;
const STRONG_PERL = new RegExp(String.raw`^(?:package\s+${NAME}(?:\s+v?\d[\d._]*)?\s*[;{]|(?:(?:my|state|our)\s+)?sub\s+${NAME}(?=\s|[({;:]|$)|use\s+(?:${NAME}|v\d)(?=\s|[;(]|\d)|(?:my|our|state|local)\s+[$@%](?:${NAME}|\{)|[$@%]${NAME}\s*=(?![=>]))`, "u");

function clearlyForeign(code: string): boolean {
  return /^(?::-[\s(]|[a-z][\w]*(?:\([^\n]*\))?\s*:-|[a-z][\w]*\([^\n]*\)\s*\.\s*(?:%.*)?$|\$\s+\S|package\s+require\s|(?:proc|puts|namespace\s+eval)\s)/m.test(code.split("\n", 1)[0]);
}

export function needsSourcePrefix(file: string, rule?: PerlFileRule): boolean {
  if (rule === "exclude") return false;
  if (rule === "perl") return true;
  if (SOURCE_METADATA.has(posix.basename(file))) return false;
  const extension = posix.extname(file).toLowerCase();
  return extension === "" || (PERL_CANDIDATE_EXTENSIONS as readonly string[]).includes(extension) || PERL_BASENAMES.has(posix.basename(file));
}

export function classifySource(file: string, prefix = "", hints: SourceHints = {}): SourceClassification | null {
  if (hints.rule === "exclude") return null;
  const perl = (reason: Extract<SourceClassification, { kind: "perl" }>["reason"], mode: "source" | "pod" = "source"): SourceClassification => ({ kind: "perl", language: "perl", mode, reason });
  if (hints.rule === "perl") return prefix.includes("\0") ? null : perl("explicit", file.toLowerCase().endsWith(".pod") ? "pod" : "source");
  const native = languageOf(file);
  if (native) return { kind: "native", native, language: languageLabelOf(file)!, reason: "extension" };
  const container = containerLangOf(file);
  if (container) return { kind: "container", language: container.name, reason: "extension" };
  const generic = genericLangOf(file);
  if (generic) return { kind: "generic", language: generic.name, reason: "extension" };
  if (!needsSourcePrefix(file) || prefix.includes("\0")) return null;
  if (!hints.includeGenerated && file.split("/").some((part) => part === "blib" || part === "_Inline")) return null;
  const extension = posix.extname(file).toLowerCase();
  if (extension === ".pod") return perl("extension", "pod");
  const first = prefix.replace(/^\uFEFF/, "");
  if (first.startsWith("#!")) return hasPerlShebang(first) ? perl("shebang") : null;
  if (PERL_BASENAMES.has(posix.basename(file))) return perl("basename");
  if (extension === ".pm" || extension === ".psgi") return perl("extension");
  if (extension !== ".pl" && extension !== ".t") return null;
  const code = firstCode(prefix);
  if (clearlyForeign(code)) return null;
  if (STRONG_PERL.test(code)) return perl("tokens");
  if (hints.project) {
    const relative = hints.project.root ? file.slice(hints.project.root.length + 1) : file;
    if (extension === ".pl" || /^(?:t|xt)\//.test(relative)) return perl("project");
  }
  return null;
}
