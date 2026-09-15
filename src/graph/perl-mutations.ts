/** Bounded entry state plus effects along source-identifiable invocations.
 * Unobserved histories between independent entries are outside this model. */
import { perlExecutionScope, perlFileExecution } from "./perl-context.js";
import { createPerlSymbolEffectResolver } from "./perl-effects.js";
import type { PerlContext, PerlFileFacts, PerlLoad, PerlModuleEnvironment, PerlSymbolMutation } from "./perl-types.js";

export interface PerlMutationState {
  active: ReadonlySet<PerlSymbolMutation>;
  /** Mutations excluded by the bounded entry/initialization interpretation. */
  excluded: readonly PerlSymbolMutation[];
}

export function createPerlInitializationMutations(files: ReadonlyMap<string, PerlFileFacts>, environment: PerlModuleEnvironment) {
  // Loaded components may call back into their importer. This grouping only
  // broadens side effects; it cannot establish a module or symbol binding.
  const parents = new Map([...files.keys()].map((file) => [file, file]));
  const root = (file: string): string => {
    const parent = parents.get(file) ?? file;
    if (parent === file) return file;
    const value = root(parent); parents.set(file, value); return value;
  };
  for (const [file, reached] of environment.reachability) for (const other of reached.keys()) {
    if (files.has(file) && files.has(other)) parents.set(root(other), root(file));
  }
  const loadTargets = new Map<string, string[]>();
  for (const [file, facts] of files) {
    const targets = facts.loads.flatMap((load) => {
      const target = environment.loads.get(load.id);
      return target && files.has(target.file) ? [target.file] : [];
    });
    loadTargets.set(file, targets);
    // A resolved deferred require can activate module callbacks in this same
    // invocation even though it is absent from initialization reachability.
    for (const target of targets) parents.set(root(target), root(file));
  }
  const potential = new Map<string, PerlSymbolMutation[]>();
  const mutationFiles = new WeakMap<PerlSymbolMutation, string>();
  for (const [file, facts] of files) potential.set(root(file), [...potential.get(root(file)) ?? [], ...facts.mutations]);
  for (const [file, facts] of files) for (const mutation of facts.mutations) mutationFiles.set(mutation, file);
  const loadedFiles = new Set([...environment.loads.values()].map((load) => load.file));
  // Anchor independent source entries to their own load context. A loaded
  // helper can call back into its importer; a sibling script is not thereby
  // part of the same invocation. Shared library sites conservatively join
  // their explicit incoming contexts because the graph has one source site.
  const entryReach = new Map<string, Set<string>>();
  const allowed = (entry: string, other: string) => {
    if (entry === other || loadedFiles.has(entry)) return true;
    let reached = entryReach.get(entry);
    if (!reached) {
      reached = new Set<string>();
      const pending = [entry];
      while (pending.length) {
        const file = pending.pop()!;
        if (reached.has(file)) continue;
        reached.add(file); pending.push(...loadTargets.get(file) ?? []);
      }
      entryReach.set(entry, reached);
    }
    return reached.has(other);
  };
  const summaries = createPerlSymbolEffectResolver(files, root, environment);
  interface Event { file: string; context: PerlContext; mutations: readonly PerlSymbolMutation[]; reentrant?: boolean; aliases?: readonly string[]; entered?: readonly string[] }
  const events = new Map<string, Event[]>();
  const callers = new Map<string, Event[]>();
  const loadedEvents: { file: string; load: PerlLoad; provider: string }[] = [];
  const forFile = (file: string): Event[] => {
    const cached = events.get(file);
    if (cached) return cached;
    const facts = files.get(file)!;
    const result: Event[] = facts.mutations.map((mutation) => ({ file, context: mutation, mutations: [mutation] }));
    for (const call of facts.calls) {
      const event = { file, context: call, mutations: summaries.forCall(file, call).map((effect) => effect.fact), reentrant: summaries.unknownInvocation(file, call), aliases: summaries.invocationNames(file, call), entered: summaries.invocationScopes(file, call) };
      result.push(event);
      for (const scope of event.entered) {
        callers.set(scope, [...callers.get(scope) ?? [], event]);
      }
    }
    for (const load of facts.loads) {
      if (load.targetKind === "pragma" || load.targetKind === "version") continue;
      const target = environment.loads.get(load.id);
      if (!target) {
        if (load.target.kind === "unknown" || load.phase === "runtime") result.push({ file, context: load, mutations: potential.get(root(file)) ?? [], reentrant: true });
        continue;
      }
      const effects = [...summaries.forLoad(target.file)];
      const loaded = files.get(target.file)!;
      const enteredScopes = new Set([loaded.scopes[0]?.id, ...[...loaded.mutations, ...loaded.calls, ...loaded.loads]
        .filter((fact) => ["compile", "BEGIN", "UNITCHECK"].includes(fact.phase))
        .map((fact) => perlExecutionScope(loaded, fact.scopeId))].filter((scope): scope is string => !!scope));
      if (load.operation !== "require" && load.arguments.kind !== "empty" && load.target.kind === "known") {
        effects.push(...summaries.forImport(target.file, load.target.value, load.operation === "no" ? "unimport" : "import"));
        for (const scope of summaries.importScopes(target.file, load.target.value, load.operation === "no" ? "unimport" : "import")) enteredScopes.add(scope);
      }
      // Unmodeled loaded code can call back into the current routine. Retain
      // later load effects for possible re-entry, including computed requires.
      const event = { file, context: load, mutations: effects.map((effect) => effect.fact), reentrant: effects.length > 0, entered: [...enteredScopes] };
      result.push(event);
      for (const scope of enteredScopes) callers.set(scope, [...callers.get(scope) ?? [], event]);
      loadedEvents.push({ file, load, provider: target.file });
    }
    events.set(file, result);
    return result;
  };
  let indexed = false;
  const index = () => {
    if (indexed) return;
    for (const file of files.keys()) if (potential.get(root(file))?.length) forFile(file);
    const byScope = new Map<string, Event[]>(), compileScopes = new Set<string>(), pending: string[] = [];
    for (const [file, entries] of events) for (const event of entries) {
      const scope = perlExecutionScope(files.get(file)!, event.context.scopeId);
      byScope.set(scope, [...byScope.get(scope) ?? [], event]);
      if (event.context.phase === "compile" || event.context.phase === "BEGIN") pending.push(...event.entered ?? []);
    }
    // A textually runtime require can execute while compiling through BEGIN,
    // a loaded module's body, or an import hook. Carry that phase through the
    // same source invocation candidates used to carry mutation state.
    while (pending.length) {
      const scope = pending.pop()!;
      if (compileScopes.has(scope)) continue;
      compileScopes.add(scope);
      for (const event of byScope.get(scope) ?? []) pending.push(...event.entered ?? []);
    }
    for (const { file, load, provider } of loadedEvents) {
      if (load.phase !== "compile" && load.phase !== "BEGIN" && !compileScopes.has(perlExecutionScope(files.get(file)!, load.scopeId))) continue;
      const context: PerlContext = { ...load, phase: "INIT" };
      const event = { file, context, mutations: summaries.forLifecycle(provider).map((effect) => effect.fact) };
      events.get(file)!.push(event);
      const facts = files.get(provider)!;
      const scopes = new Set([...facts.mutations, ...facts.calls, ...facts.loads]
        .filter((fact) => fact.phase === "CHECK" || fact.phase === "INIT")
        .map((fact) => perlExecutionScope(facts, fact.scopeId)));
      for (const scope of scopes) callers.set(scope, [...callers.get(scope) ?? [], event]);
    }
    indexed = true;
  };
  const before = (event: PerlContext, site: PerlContext) => event.range.end <= site.range.start
    // Argument expressions execute before the enclosing callee is selected.
    || event.range.start >= site.range.start && event.range.end <= site.range.end
      && (event.range.start > site.range.start || event.range.end < site.range.end);
  const reentryMemo = new Map<string, boolean>();
  const localMemo = new WeakMap<PerlContext, { scope: string; mutations: ReadonlySet<PerlSymbolMutation> }>();
  const localAt = (file: string, context: PerlContext) => {
    const cached = localMemo.get(context);
    if (cached) return cached;
    const facts = files.get(file)!;
    const scope = perlExecutionScope(facts, context.scopeId);
    const deferred = !perlFileExecution(facts, context.scopeId);
    const early = context.phase === "compile" || context.phase === "BEGIN";
    const unordered = facts.initializationOrderUnknown || context.conditional || context.scopeId !== scope;
    const currentEvents = forFile(file);
    let reentrant = reentryMemo.get(scope);
    if (reentrant === undefined) {
      reentrant = deferred && (facts.mutations.some((mutation) => mutation.names.kind === "unknown" && mutation.mechanism !== "framework"
        && perlExecutionScope(facts, mutation.scopeId) === scope)
        || currentEvents.some((event) => perlExecutionScope(facts, event.context.scopeId) === scope && (event.reentrant
          || event.aliases?.length && currentEvents.some((prior) => (before(prior.context, event.context)
            && perlExecutionScope(facts, prior.context.scopeId) === scope || perlFileExecution(facts, prior.context.scopeId) || ["compile", "BEGIN", "UNITCHECK", "CHECK", "INIT"].includes(prior.context.phase))
            && prior.mutations.some((mutation) => !mutation.emptyReplacement && mutation.names.kind === "known" && mutation.names.value.some((name) => event.aliases!.includes(name)))))));
      reentryMemo.set(scope, reentrant);
    }
    const mutations = new Set<PerlSymbolMutation>();
    for (const event of currentEvents) {
      const fact = event.context;
      const compile = fact.phase === "compile" || fact.phase === "BEGIN";
      const initialization = ["compile", "BEGIN", "UNITCHECK", "CHECK", "INIT"].includes(fact.phase) || perlFileExecution(facts, fact.scopeId);
      const sameScope = perlExecutionScope(facts, fact.scopeId) === scope;
      const applicable = early ? compile && before(fact, context)
        : initialization && (fact.phase !== "runtime" || deferred || unordered || before(fact, context))
          || sameScope && (unordered || reentrant || before(fact, context));
      if (applicable) for (const mutation of event.mutations) mutations.add(mutation);
    }
    const result = { scope, mutations };
    localMemo.set(context, result);
    return result;
  };
  const incomingMemo = new Map<string, Map<string, ReadonlySet<PerlSymbolMutation>>>();
  const incoming = (file: string, scope: string): ReadonlySet<PerlSymbolMutation> => {
    let cache = incomingMemo.get(file);
    if (!cache) { cache = new Map(); incomingMemo.set(file, cache); }
    const cached = cache.get(scope);
    if (cached) return cached;
    const active = new Set<PerlSymbolMutation>(), pending = [scope], seen = new Set<string>();
    // Complete each backward closure before caching it. In particular, do not
    // cache an incomplete result when a recursive component is first visited.
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const caller of callers.get(current) ?? []) {
        if (!allowed(file, caller.file)) continue;
        const local = localAt(caller.file, caller.context);
        for (const mutation of local.mutations) if (allowed(file, mutationFiles.get(mutation)!)) active.add(mutation);
        pending.push(local.scope);
      }
    }
    cache.set(scope, active);
    return active;
  };
  const memo = new WeakMap<PerlContext, PerlMutationState>();
  const at = (file: string, site: PerlContext): PerlMutationState => {
    const cached = memo.get(site);
    if (cached) return cached;
    const possible = potential.get(root(file)) ?? [];
    if (!possible.length) {
      const result = { active: new Set<PerlSymbolMutation>(), excluded: [] };
      memo.set(site, result); return result;
    }
    index();
    const local = localAt(file, site);
    const active = new Set(incoming(file, local.scope));
    for (const mutation of local.mutations) if (allowed(file, mutationFiles.get(mutation)!)) active.add(mutation);
    const deferred = !perlFileExecution(files.get(file)!, site.scopeId);
    const result = { active, excluded: deferred ? (potential.get(root(file)) ?? []).filter((mutation) => allowed(file, mutationFiles.get(mutation)!) && !active.has(mutation)) : [] };
    memo.set(site, result);
    return result;
  };
  const importMemo = new WeakMap<PerlLoad, PerlMutationState>();
  const imported = (file: string, load: PerlLoad, provider: string): PerlMutationState => {
    const cached = importMemo.get(load);
    if (cached) return cached;
    // Capture after loading the provider and running the import hook. Consumer
    // effects occurring later cannot retroactively alter that captured target.
    const active = new Set(at(file, load).active);
    for (const effect of summaries.forLoad(provider)) active.add(effect.fact);
    if (load.target.kind === "known") for (const effect of summaries.forImport(provider, load.target.value, "import")) active.add(effect.fact);
    const result = { active, excluded: (potential.get(root(file)) ?? []).filter((mutation) => !active.has(mutation)) };
    importMemo.set(load, result);
    return result;
  };
  return { at, imported };
}
