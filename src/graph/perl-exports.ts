/** Supported literal Exporter tables. No importer or project code is executed. */
import type { PerlFileFacts, PerlImportArguments, PerlKnown } from "./perl-types.js";
import { known, unknown, PERL_NAME } from "./perl-syntax.js";

function symbolName(name: string): string | null {
  const normalized = name.replace(/^&/, "");
  return PERL_NAME.test(normalized.replace(/^[$@%]/, "")) && !normalized.includes("::") ? normalized : null;
}

export function perlExportNames(facts: PerlFileFacts, packageName: string, args: PerlImportArguments): PerlKnown<string[]> {
  if (args.kind === "empty") return known([]);
  if (args.kind === "unknown") return args;
  if (facts.definitions.some((d) => d.packageName === packageName && d.name === "import" && d.hasBody)) return unknown("custom import method");
  const entries = facts.exports.filter((e) => e.packageName === packageName);
  const supported = entries.some((e) => e.exporter !== "unknown") || facts.loads.some((l) => l.packageName === packageName && l.operation === "use" && l.target.kind === "known" && l.target.value === "Exporter" && l.arguments.kind === "list" && l.arguments.symbols.includes("import"));
  if (!supported) return unknown("no supported Exporter binding");
  if (facts.diagnostics.some((d) => d.code === "PERL_PARSE_ERROR" || d.code === "PERL_OPAQUE_RECOVERY")) return unknown("exporting file is partially parsed");
  const tables = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.exporter === "unknown" || entry.unknownMutation || entry.symbols.kind === "unknown") return unknown("computed or mutated export table");
    if (entry.resetTags) for (const key of tables.keys()) if (key.startsWith(":")) tables.delete(key);
    if (entry.kind === "tag" && entry.tag === undefined && !entry.symbols.value.length) continue;
    const key = entry.kind === "tag" ? `:${entry.tag ?? ""}` : entry.kind;
    const names = entry.symbols.value.map(symbolName);
    if (names.some((name) => name === null)) return unknown("qualified or unsupported export alias");
    tables.set(key, [...new Set([...(entry.operation === "append" ? tables.get(key) ?? [] : []), ...names as string[]])]);
  }
  const defaults = tables.get("default") ?? [];
  const allowed = new Set([...defaults, ...tables.get("optional") ?? []]);
  if (args.kind === "default") return known(defaults);
  const selected = new Set<string>(args.symbols[0]?.startsWith("!") ? defaults : []);
  for (const request of args.symbols) {
    const exclude = request.startsWith("!");
    const name = exclude ? request.slice(1) : request;
    const expanded = name === ":DEFAULT" ? defaults : name.startsWith(":") ? tables.get(name) : [symbolName(name)];
    if (!expanded || expanded.some((n) => n === null || !allowed.has(n))) return unknown(`export request ${request} is not in the supported tables`);
    for (const symbol of expanded as string[]) { if (exclude) selected.delete(symbol); else selected.add(symbol); }
  }
  return known([...selected]);
}
