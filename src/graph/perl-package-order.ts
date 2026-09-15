/** Declaration order for source packages reopened by resolved module loads. */
import { perlFileExecution } from "./perl-context.js";
import { PERL_LIST_BUILTINS } from "./perl-syntax.js";
import type { PerlBinding, PerlCall, PerlContext, PerlDefinition, PerlFileFacts, PerlInheritance, PerlLoad, PerlModuleEnvironment, PerlSymbolMutation } from "./perl-types.js";

export interface PerlPackageTimeline {
  ordered: boolean;
  definitions: Map<string, number>;
  inheritance: Map<PerlInheritance, number>;
  aliases: Map<PerlSymbolMutation, number>;
  captures: Set<PerlBinding>;
  uncertainDefinitions: Set<string>;
  uncertainInheritance: Set<string>;
}
type Event = { at: number } & ({ definition: PerlDefinition } | { inheritance: PerlInheritance } | { load: PerlLoad } | { alias: PerlSymbolMutation } | { capture: PerlBinding });
type TraceEvent = Event | { at: number; call: PerlCall } | { at: number; mutation: PerlSymbolMutation };
export interface PerlInitializationTrace {
  events: { file: string; event: TraceEvent }[];
}

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
      ...facts.mutations.filter(mutation => mutation.aliasReference || mutation.replacementNodeId).map(alias => ({ at: phaseOrder(facts, alias), alias })),
      ...facts.bindings.filter(binding => binding.captureReference).map(capture => ({ at: phaseOrder(facts, capture.captureReference!), capture })),
      ...facts.loads.filter(load => load.targetKind !== "version" && load.targetKind !== "pragma")
        .map(load => ({ at: phaseOrder(facts, load), load })),
    ].sort((a, b) => a.at - b.at);
    events.set(file, result); return result;
  };
  const timeline = (file: string, site?: PerlContext): PerlPackageTimeline | null => {
    const root = site && deferred(file, site) ? entry(file, site.packageName) : file;
    const stop = site && !deferred(file, site) ? phaseOrder(files.get(file)!, site) : Infinity;
    const key = `${root}\0${stop}\0${site && deferred(file, site) ? "deferred" : "initialization"}`;
    if (timelines.has(key)) return timelines.get(key)!;
    const result: PerlPackageTimeline = { ordered: true, definitions: new Map(), inheritance: new Map(), aliases: new Map(), captures: new Set(), uncertainDefinitions: new Set(), uncertainInheritance: new Set() };
    const loaded = new Set<string>(), active = new Set<string>();
    let next = 0, valid = true;
    const visit = (current: string) => {
      if (active.has(current) || active.size >= 256) { valid = false; return; }
      const facts = files.get(current)!;
      if (facts.initializationOrderUnknown) valid = false;
      if (site && deferred(file, site)) {
        const aliases = [...facts.mutations.filter(mutation => mutation.aliasReference || mutation.replacementNodeId),
          ...facts.bindings.flatMap(binding => binding.captureReference ? [binding.captureReference] : [])]
          .filter(fact => fact.phase === "runtime" && perlFileExecution(facts, fact.scopeId));
        const lastAlias = Math.max(-1, ...aliases.map(alias => alias.range.start));
        const lastLoad = Math.max(-1, ...[...facts.loads, ...aliases]
          .filter(effect => effect.phase === "runtime" && perlFileExecution(facts, effect.scopeId)).map(effect => effect.range.start));
        // A top-level callback before later loads can enter a method before
        // initialization is complete. Do not use the final definition order
        // as a proof for all invocations of that method.
        if (facts.calls.some(call => perlFileExecution(facts, call.scopeId) && call.range.start < lastLoad
          && !(call.name.kind === "known" && call.form === "bare" && (call.syntax === "builtin" || PERL_LIST_BUILTINS.has(call.name.value))))) valid = false;
        // Even `use Module ()` executes its initializer. It can call back into
        // a routine before that routine's runtime alias assignments execute.
        if (lastAlias >= 0 && facts.loads.some(load => load.targetKind !== "pragma" && load.targetKind !== "version"
          && (["compile", "BEGIN", "UNITCHECK"].includes(load.phase) || perlFileExecution(facts, load.scopeId) && load.range.start < lastAlias))) valid = false;
      }
      active.add(current);
      for (const event of forFile(current)) {
        if (current === root && event.at >= stop) break;
        if ("definition" in event) {
          if (event.definition.hasBody && !event.definition.conditional) result.definitions.set(event.definition.nodeId, next++);
        } else if ("inheritance" in event) {
          const fact = event.inheritance;
          if (["compile", "BEGIN", "UNITCHECK"].includes(fact.phase) || perlFileExecution(facts, fact.scopeId)) result.inheritance.set(fact, next++);
        } else if ("alias" in event) {
          const alias = event.alias;
          if (!alias.conditional && facts.scopes[0]?.contextKnown && perlFileExecution(facts, alias.scopeId) && alias.phase === "runtime") result.aliases.set(alias, next++);
        } else if ("capture" in event) {
          const capture = event.capture, ref = capture.captureReference!;
          if (!ref.conditional && facts.scopes[0]?.contextKnown && perlFileExecution(facts, ref.scopeId) && ref.phase === "runtime") result.captures.add(capture);
        } else {
          const load = event.load, target = environment.loads.get(load.id);
          if (!target || !(["compile", "BEGIN", "UNITCHECK"].includes(load.phase) || perlFileExecution(facts, load.scopeId))) continue;
          if (load.conditional) {
            for (const other of environment.reachability.get(target.file)?.keys() ?? [target.file]) {
              const possible = files.get(other)!;
              for (const definition of possible.definitions) if (definition.hasBody) result.uncertainDefinitions.add(definition.qualifiedName);
              for (const mutation of possible.mutations) if ((mutation.aliasReference || mutation.replacementNodeId) && mutation.names.kind === "known") for (const name of mutation.names.value) result.uncertainDefinitions.add(name);
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
  const incoming = new Map<string, { file: string; load: PerlLoad }[]>();
  for (const [file, facts] of files) for (const load of facts.loads) {
    const target = environment.loads.get(load.id);
    if (target) incoming.set(target.file, [...incoming.get(target.file) ?? [], { file, load }]);
  }
  const dominators = new Map<string, boolean>();
  const dominates = (root: string, file: string, seen = new Set<string>()): boolean => {
    if (root === file) return true;
    if (seen.has(file)) return false;
    const key = `${root}\0${file}`;
    if (dominators.has(key)) return dominators.get(key)!;
    const callers = incoming.get(file) ?? [], next = new Set(seen).add(file);
    const requests = new Set(callers.map(({ load }) => load.target.kind === "known"
      ? load.targetKind === "module" ? `${load.target.value.replaceAll("::", "/")}.pm` : load.target.value : load.id));
    const result = callers.length > 0 && requests.size === 1 && callers.every(({ file: caller, load }) => load.operation !== "do"
      && !load.conditional && (["compile", "BEGIN", "UNITCHECK"].includes(load.phase) || perlFileExecution(files.get(caller)!, load.scopeId))
      && dominates(root, caller, next));
    dominators.set(key, result); return result;
  };
  const traceEvents = new Map<string, TraceEvent[]>();
  const tracedFile = (file: string): TraceEvent[] => {
    const cached = traceEvents.get(file);
    if (cached) return cached;
    const facts = files.get(file)!;
    const initialized = (fact: PerlContext) => ["compile", "BEGIN", "UNITCHECK"].includes(fact.phase) || perlFileExecution(facts, fact.scopeId);
    const after = (fact: PerlContext) => phaseOrder(facts, { ...fact, range: { ...fact.range, start: fact.range.end } });
    const result: TraceEvent[] = [...forFile(file).filter(event => !("alias" in event) || initialized(event.alias))
      .map(event => "alias" in event ? { ...event, at: after(event.alias) } : event),
      ...facts.calls.filter(initialized).map(call => ({ at: after(call), call })),
      ...facts.mutations.filter(mutation => initialized(mutation) && !mutation.aliasReference && !mutation.replacementNodeId)
        .map(mutation => ({ at: after(mutation), mutation })),
    ].sort((a, b) => a.at - b.at);
    traceEvents.set(file, result); return result;
  };
  const traces = new WeakMap<PerlContext, PerlInitializationTrace | null>();
  const initialization = (file: string, site: PerlContext): PerlInitializationTrace | null => {
    if (traces.has(site)) return traces.get(site)!;
    traces.set(site, null);
    if (site.phase !== "runtime" || site.conditional || !perlFileExecution(files.get(file)!, site.scopeId)) return null;
    const root = entry(file, site.packageName);
    if (root === file || !dominates(root, file)) return null;
    // One source capture site may execute again after %INC changes or do-file
    // reloads. A trace of its first initialization cannot prove all instances.
    for (const [owner, facts] of files) if (environment.reachability.get(owner)?.has(file) || environment.reachability.get(root)?.has(owner)) {
      if (facts.includeEffects.some(effect => effect.affectsLoaded) || facts.loads.some(load => load.operation === "do")) return null;
    }
    const stop = phaseOrder(files.get(file)!, site), result: PerlInitializationTrace = { events: [] };
    const active = new Set<string>(), loaded = new Map<string, string>();
    let valid = true, stopped = false;
    const visit = (current: string) => {
      const facts = files.get(current)!;
      if (active.has(current) || active.size >= 256 || facts.initializationOrderUnknown) { valid = false; return; }
      active.add(current);
      for (const event of tracedFile(current)) {
        if (!valid || stopped) break;
        if (current === file && event.at >= stop) { stopped = true; break; }
        if ("load" in event) {
          const load = event.load;
          if (!["compile", "BEGIN", "UNITCHECK"].includes(load.phase) && !perlFileExecution(facts, load.scopeId)) continue;
          const target = environment.loads.get(load.id);
          if (target && !load.conditional && load.operation !== "do") {
            const request = load.target.kind === "known" ? load.targetKind === "module" ? `${load.target.value.replaceAll("::", "/")}.pm` : load.target.value : load.id;
            // Different requests for one physical file can initialize it twice.
            if (loaded.has(target.file) && loaded.get(target.file) !== request) { valid = false; break; }
            if (!loaded.has(target.file)) { loaded.set(target.file, request); visit(target.file); }
          }
        }
        if (!stopped) result.events.push({ file: current, event });
      }
      if (current === file) stopped = true;
      active.delete(current);
    };
    visit(root);
    if (!valid || !stopped) return null;
    traces.set(site, result); return result;
  };
  return { entry, deferred, timeline, forReach, initialization };
}
