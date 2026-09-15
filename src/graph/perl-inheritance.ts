/** Complete source-owned Perl method lookup orders. No runtime metaprogramming. */
import type { PerlContext, PerlFileFacts, PerlInheritance, PerlKnown, PerlModuleEnvironment, PerlModuleTarget } from "./perl-types.js";
import { known, unknown } from "./perl-syntax.js";
import { weakerPerlConfidence } from "./perl-modules.js";
import { createPerlPackageOrder } from "./perl-package-order.js";

type Confidence = PerlModuleTarget["confidence"];
export interface PerlClassTarget {
  packageName: string;
  file: string;
  nodeId?: string;
  confidence: Confidence;
}
export interface PerlClassState {
  target: PerlClassTarget;
  parents: string[];
  mro: "dfs" | "c3";
  /** Internal prefix reads stop before these unresolved parent alternatives. */
  incomplete?: string;
}
export interface PerlInheritanceResolver {
  state(packageName: string, reachable: ReadonlyMap<string, Confidence>, site?: { file: string; context: PerlContext }): PerlKnown<PerlClassState>;
  linearize(packageName: string, reachable: ReadonlyMap<string, Confidence>, site?: { file: string; context: PerlContext }): PerlKnown<PerlClassTarget[]>;
  linearizePrefix(packageName: string, reachable: ReadonlyMap<string, Confidence>, site?: { file: string; context: PerlContext }): PerlClassTarget[];
}

function order(facts: PerlFileFacts, fact: PerlInheritance): number {
  if (fact.phase === "compile") return fact.range.start;
  if (fact.phase === "BEGIN") return facts.scopes.find((s) => s.ownerNode === fact.sourceNode && s.kind === "phaser")?.range.end ?? fact.range.end;
  return 1_000_000_000 + fact.range.start;
}

export function createPerlInheritanceResolver(files: ReadonlyMap<string, PerlFileFacts>, environment: PerlModuleEnvironment, packageOrder = createPerlPackageOrder(files, environment)): PerlInheritanceResolver {
  const stateCache = new Map<string, PerlKnown<PerlClassState>>();
  const linearCache = new Map<string, PerlKnown<PerlClassTarget[]>>();
  const prefixCache = new Map<string, PerlClassTarget[]>();
  const keyOf = (name: string, reachable: ReadonlyMap<string, Confidence>, site?: { file: string; context: PerlContext }) => `${name}\0${[...reachable].sort(([a], [b]) => a.localeCompare(b)).map(([f, c]) => `${f}:${c}`).join("\0")}\0${site && (site.context.phase === "compile" || site.context.phase === "BEGIN" || site.context.sourceNode === site.file) ? `${site.file}:${site.context.phase}:${site.context.range.start}` : "runtime"}`;
  const readState = (name: string, reachable: ReadonlyMap<string, Confidence>, site?: { file: string; context: PerlContext }, prefix = false): PerlKnown<PerlClassState> => {
    const key = `${keyOf(name, reachable, site)}\0${prefix}`;
    const cached = stateCache.get(key);
    if (cached) return cached;
    const compute = (): PerlKnown<PerlClassState> => {
      const candidates = (environment.packageFiles.get(name) ?? []).filter((file) => reachable.has(file));
      if (!candidates.length) return unknown(`No reachable source package for ${name}`);
      for (const file of candidates) {
        const facts = files.get(file)!;
        if (facts.diagnostics.some((d) => ["PERL_PARSE_ERROR", "PERL_OPAQUE_RECOVERY", "PERL_PACKAGE_CONTEXT_UNKNOWN"].includes(d.code))) return unknown(`Partially parsed hierarchy owner ${file}`);
        if (facts.mutations.some((m) => m.names.kind === "unknown" ? m.packageName === name : m.names.value.some((n) => n === `${name}::ISA`))) return unknown(`Mutated package ${name}`);
      }
      const owners = [...files].filter(([contextFile, f]) => reachable.has(contextFile) && f.inheritance.some((i) => i.packageName === name || i.allPackages));
      const timeline = packageOrder.forReach(reachable, site);
      if (timeline?.uncertainInheritance.has(name)) return unknown(`Conditional hierarchy load for ${name}`);
      const events = owners.flatMap(([contextFile, f]) => f.inheritance.filter((i) => i.packageName === name || i.allPackages).map((fact) => ({ file: contextFile, facts: f, fact })));
      if (owners.length > 1 && (!timeline?.ordered || events.some(event => !timeline.inheritance.has(event.fact)))) return unknown(`Hierarchy for ${name} changes in multiple files with unknown execution order`);
      events.sort((a, b) => owners.length > 1 ? timeline!.inheritance.get(a.fact)! - timeline!.inheritance.get(b.fact)! : order(a.facts, a.fact) - order(b.facts, b.fact));
      // The hierarchy declaration provides the package node for a reopened
      // package. A file that only adds methods is not a conflicting class.
      const file = events.find(event => candidates.includes(event.file))?.file ?? candidates[0];
      const facts = files.get(file)!, region = facts.packages.find((p) => p.name === name);
      let parents: string[] = [], mro: "dfs" | "c3" = "dfs";
      let incomplete: string | undefined;
      let confidence = candidates.reduce<Confidence>((value, candidate) => weakerPerlConfidence(value, reachable.get(candidate)!), reachable.get(file)!);
      for (const event of events) {
        const fact = event.fact;
        if (site && event.file === site.file) {
          const early = site.context.phase === "compile" || site.context.phase === "BEGIN";
          if (early && (fact.phase !== "compile" && fact.phase !== "BEGIN" || order(event.facts, fact) > site.context.range.start)) continue;
          if (!early && site.context.sourceNode === site.file && fact.phase !== "compile" && fact.phase !== "BEGIN" && fact.range.end > site.context.range.start) continue;
        }
        if (fact.unknownMutation || fact.conditional) return unknown(`Unknown hierarchy mutation for ${name}`);
        if (fact.parents.kind === "unknown") {
          if (!prefix || fact.operation !== "append" || !fact.parentAlternatives?.length) return unknown(`Unknown hierarchy mutation for ${name}`);
          // Appending an unknown suffix leaves the existing prefix in place.
          // Never append the alternatives as though every parent is present.
          const common: string[] = [];
          for (const [index, parent] of fact.parentAlternatives[0].entries()) {
            if (!fact.parentAlternatives.every(choice => choice[index] === parent)) break;
            common.push(parent);
          }
          if (!incomplete) parents = [...new Set([...parents, ...common])];
          incomplete = `Alternative parents for ${name}`;
          continue;
        }
        if (fact.adapterLoadId && environment.loads.has(fact.adapterLoadId)) return unknown(`Local module shadows the ${fact.mechanism} adapter`);
        if (fact.mechanism === "mro") {
          if (fact.mro === "unknown") return unknown(`Unknown MRO for ${name}`);
          mro = fact.mro; continue;
        }
        if (fact.loadIds?.some((id) => !environment.loads.has(id) && !event.facts.loads.some((load) => load.id === id && load.target.kind === "known" && load.target.value === "Exporter"))) {
          // base deliberately tolerates a missing filename when the package
          // already has source declarations; parent does not.
          const localBase = fact.mechanism === "base" && fact.parents.value.every((parent) => facts.definitions.some((d) => d.packageName === parent && d.hasBody && d.range.end < fact.range.start));
          if (!localBase) return unknown(`A required parent module for ${name} was not resolved`);
        }
        for (const id of fact.loadIds ?? []) if (environment.loads.has(id)) confidence = weakerPerlConfidence(confidence, environment.loads.get(id)!.confidence);
        if (fact.operation === "replace") { parents = [...new Set(fact.parents.value)]; incomplete = undefined; }
        else if (!incomplete) parents = [...new Set([...parents, ...fact.parents.value])];
      }
      return known({ target: { packageName: name, file, ...(region ? { nodeId: region.nodeId } : {}), confidence }, parents, mro, ...(incomplete ? { incomplete } : {}) });
    };
    const result = compute(); stateCache.set(key, result); return result;
  };
  const state: PerlInheritanceResolver["state"] = (name, reachable, site) => readState(name, reachable, site);
  const linearize: PerlInheritanceResolver["linearize"] = (name, reachable, site) => {
    const key = keyOf(name, reachable, site);
    const cached = linearCache.get(key);
    if (cached) return cached;
    const root = state(name, reachable, site);
    if (root.kind === "unknown") return root;
    const algorithm = root.value.mro;
    const active = new Set<string>();
    const memo = new Map<string, PerlClassTarget[]>();
    const visit = (current: string): PerlKnown<PerlClassTarget[]> => {
      if (active.has(current)) return unknown(`Cyclic Perl inheritance at ${current}`);
      if (active.size >= 256) return unknown("Perl inheritance exceeds the supported depth bound");
      const prior = memo.get(current); if (prior) return known(prior);
      const info = state(current, reachable, site); if (info.kind === "unknown") return info;
      active.add(current);
      const parentOrders: PerlClassTarget[][] = [];
      for (const parent of info.value.parents) {
        const result = visit(parent);
        if (result.kind === "unknown") { active.delete(current); return result; }
        parentOrders.push(result.value);
      }
      active.delete(current);
      const result: PerlClassTarget[] = [info.value.target];
      if (algorithm === "dfs") {
        const seen = new Set([current]);
        for (const list of parentOrders) for (const target of list) if (!seen.has(target.packageName)) { seen.add(target.packageName); result.push(target); }
      } else {
        const lists = [...parentOrders.map((list) => [...list]), parentOrders.map((list) => list[0])].filter((list) => list.length);
        while (lists.some((list) => list.length)) {
          const head = lists.find((list) => list.length && !lists.some((other) => other.slice(1).some((candidate) => candidate.packageName === list[0].packageName)))?.[0];
          if (!head) return unknown(`Inconsistent C3 parent order for ${current}`);
          result.push(head);
          for (const list of lists) if (list[0]?.packageName === head.packageName) list.shift();
        }
      }
      // Every path used to establish the complete order contributes evidence.
      const confidence = result.reduce((c, target) => weakerPerlConfidence(c, target.confidence), "extracted" as Confidence);
      const qualified = result.map((target) => ({ ...target, confidence }));
      memo.set(current, qualified); return known(qualified);
    };
    const result = visit(name); linearCache.set(key, result); return result;
  };
  const linearizePrefix: PerlInheritanceResolver["linearizePrefix"] = (name, reachable, site) => {
    const key = keyOf(name, reachable, site), cached = prefixCache.get(key);
    if (cached) return cached;
    const root = readState(name, reachable, site, true);
    // A C3 order depends on the complete graph. DFS can stop exactly where
    // the first unavailable ancestor would be searched.
    if (root.kind === "unknown" || root.value.mro !== "dfs") return [];
    const result: PerlClassTarget[] = [], seen = new Set<string>();
    let confidence: Confidence = "extracted";
    const visit = (current: string, depth: number): boolean => {
      if (depth >= 256) return false;
      if (seen.has(current)) return true;
      const info = readState(current, reachable, site, true);
      if (info.kind === "unknown") return false;
      seen.add(current);
      confidence = weakerPerlConfidence(confidence, info.value.target.confidence);
      result.push({ ...info.value.target, confidence });
      for (const parent of info.value.parents) if (!visit(parent, depth + 1)) return false;
      return !info.value.incomplete;
    };
    visit(name, 0);
    prefixCache.set(key, result);
    return result;
  };
  return { state, linearize, linearizePrefix };
}
