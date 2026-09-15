/** Declaration order for source packages reopened by resolved module loads. */
import { perlFileExecution } from "./perl-context.js";
import { PERL_LIST_BUILTINS } from "./perl-syntax.js";
import type { PerlContext, PerlDefinition, PerlFileFacts, PerlInheritance, PerlLoad, PerlModuleEnvironment } from "./perl-types.js";

export interface PerlPackageTimeline {
  ordered: boolean;
  definitions: Map<string, number>;
  inheritance: Map<PerlInheritance, number>;
  uncertainDefinitions: Set<string>;
  uncertainInheritance: Set<string>;
}
type Event = { at: number } & ({ definition: PerlDefinition } | { inheritance: PerlInheritance } | { load: PerlLoad });

export function createPerlPackageOrder(files: ReadonlyMap<string, PerlFileFacts>, environment: PerlModuleEnvironment) {
  const entries = new Map<string, string>();
  const events = new Map<string, Event[]>();
  const timelines = new Map<string, PerlPackageTimeline | null>();
  const phaseOrder = (facts: PerlFileFacts, fact: PerlContext): number => {
    if (fact.phase === "compile") return fact.range.start;
    if (fact.phase === "BEGIN") return facts.scopes.find(scope => scope.ownerNode === fact.sourceNode && scope.kind === "phaser")?.range.end ?? fact.range.end;
    if (fact.phase === "UNITCHECK") return 900_000_000 - fact.range.end;
    return 1_000_000_000 + fact.range.start;
  };
  const deferred = (file: string, site: PerlContext) => site.phase === "runtime" && !perlFileExecution(files.get(file)!, site.scopeId);
  const entry = (file: string, packageName: string): string => {
    const key = `${file}\0${packageName}`;
    const cached = entries.get(key);
    if (cached) return cached;
    // A reopened package may use its loading module's initialization context.
    // Only a unique outer owner qualifies; unrelated same-package files and
    // independent loaders must never be merged merely by package spelling.
    const owners = (environment.packageFiles.get(packageName) ?? []).filter(owner => environment.reachability.get(owner)?.has(file));
    const outer = owners.filter(owner => !owners.some(other => other !== owner
      && environment.reachability.get(other)?.has(owner) && !environment.reachability.get(owner)?.has(other)));
    const result = outer.length === 1 ? outer[0] : file;
    entries.set(key, result); return result;
  };
  const forFile = (file: string): Event[] => {
    const cached = events.get(file);
    if (cached) return cached;
    const facts = files.get(file)!;
    const result: Event[] = [
      ...facts.definitions.filter(definition => ["package-sub", "method", "constant"].includes(definition.kind))
        .map(definition => ({ at: definition.range.end, definition })),
      ...facts.inheritance.map(inheritance => ({ at: phaseOrder(facts, inheritance), inheritance })),
      ...facts.loads.filter(load => load.targetKind !== "version" && load.targetKind !== "pragma")
        .map(load => ({ at: phaseOrder(facts, load), load })),
    ].sort((a, b) => a.at - b.at);
    events.set(file, result); return result;
  };
  const timeline = (file: string, site?: PerlContext): PerlPackageTimeline | null => {
    const root = site && deferred(file, site) ? entry(file, site.packageName) : file;
    const stop = site && !deferred(file, site) ? phaseOrder(files.get(file)!, site) : Infinity;
    const key = `${root}\0${stop}`;
    if (timelines.has(key)) return timelines.get(key)!;
    const result: PerlPackageTimeline = { ordered: true, definitions: new Map(), inheritance: new Map(), uncertainDefinitions: new Set(), uncertainInheritance: new Set() };
    const loaded = new Set<string>(), active = new Set<string>();
    let next = 0, valid = true;
    const visit = (current: string) => {
      if (active.has(current) || active.size >= 256) { valid = false; return; }
      const facts = files.get(current)!;
      if (facts.initializationOrderUnknown) valid = false;
      if (site && deferred(file, site)) {
        const lastLoad = Math.max(-1, ...facts.loads.filter(load => load.phase === "runtime" && perlFileExecution(facts, load.scopeId)).map(load => load.range.start));
        // A top-level callback before later loads can enter a method before
        // initialization is complete. Do not use the final definition order
        // as a proof for all invocations of that method.
        if (facts.calls.some(call => perlFileExecution(facts, call.scopeId) && call.range.start < lastLoad
          && !(call.name.kind === "known" && call.form === "bare" && (call.syntax === "builtin" || PERL_LIST_BUILTINS.has(call.name.value))))) valid = false;
      }
      active.add(current);
      for (const event of forFile(current)) {
        if (current === root && event.at >= stop) break;
        if ("definition" in event) {
          if (event.definition.hasBody && !event.definition.conditional) result.definitions.set(event.definition.nodeId, next++);
        } else if ("inheritance" in event) {
          const fact = event.inheritance;
          if (["compile", "BEGIN", "UNITCHECK"].includes(fact.phase) || perlFileExecution(facts, fact.scopeId)) result.inheritance.set(fact, next++);
        } else {
          const load = event.load, target = environment.loads.get(load.id);
          if (!target || !(["compile", "BEGIN", "UNITCHECK"].includes(load.phase) || perlFileExecution(facts, load.scopeId))) continue;
          if (load.conditional) {
            for (const other of environment.reachability.get(target.file)?.keys() ?? [target.file]) {
              const possible = files.get(other)!;
              for (const definition of possible.definitions) if (definition.hasBody) result.uncertainDefinitions.add(definition.qualifiedName);
              for (const inheritance of possible.inheritance) result.uncertainInheritance.add(inheritance.packageName);
            }
            continue;
          }
          const request = load.target.kind === "known" ? load.targetKind === "module" ? load.target.value.replaceAll("::", "/") + ".pm" : load.target.value : load.id;
          if (load.operation !== "do" && loaded.has(request)) continue;
          loaded.add(request);
          visit(target.file);
        }
      }
      active.delete(current);
    };
    visit(root);
    result.ordered = valid;
    timelines.set(key, result); return result;
  };
  const forReach = (reached: ReadonlyMap<string, unknown>, site?: { file: string; context: PerlContext }): PerlPackageTimeline | null => {
    if (site) return timeline(site.file, site.context);
    const roots = [...reached.keys()].filter(file => [...reached.keys()].every(other => environment.reachability.get(file)?.has(other)));
    return roots.length === 1 ? timeline(roots[0]) : null;
  };
  return { entry, deferred, timeline, forReach };
}
