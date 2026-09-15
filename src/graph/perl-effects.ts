/** Source call summaries used only to invalidate state, never to prove a
 * call edge. Candidate sets deliberately include competing package bodies. */
import { perlExecutionScope, perlFileExecution } from "./perl-context.js";
import { PERL_LIST_BUILTINS } from "./perl-syntax.js";
import type { PerlBinding, PerlCall, PerlContext, PerlFileFacts, PerlIncludeEffect, PerlLoad, PerlModuleEnvironment, PerlReference, PerlSymbolMutation } from "./perl-types.js";

interface Effect<T> { file: string; fact: T }
interface Body { file: string; scope: string }
interface Dispatch { scopes: string[]; dynamic: boolean }

export function createPerlLoadEffectResolver(files: ReadonlyMap<string, PerlFileFacts>, projectOf: (file: string) => string,
  additionalLoadCandidates?: (file: string, load: PerlLoad) => readonly string[]) {
  return createPerlSourceEffectResolver(files, projectOf, (facts) => facts.includeEffects,
    (load): PerlIncludeEffect => ({ ...load, operation: "unknown", directories: { kind: "unknown", reason: "called routine has a computed load target" }, affectsLoaded: true, affectsCwd: true }), undefined, additionalLoadCandidates);
}

export function createPerlSymbolEffectResolver(files: ReadonlyMap<string, PerlFileFacts>, projectOf: (file: string) => string, environment?: PerlModuleEnvironment) {
  return createPerlSourceEffectResolver(files, projectOf, (facts) => facts.mutations, undefined, environment);
}

function createPerlSourceEffectResolver<T extends PerlContext>(files: ReadonlyMap<string, PerlFileFacts>, identifyProject: (file: string) => string, select: (facts: PerlFileFacts) => readonly T[], unknownLoad?: (load: PerlLoad) => T, symbolEnvironment?: PerlModuleEnvironment,
  additionalLoadCandidates?: (file: string, load: PerlLoad) => readonly string[]) {
  const projectByFile = new Map([...files.keys()].map((file) => [file, identifyProject(file)]));
  const projectOf = (file: string): string => projectByFile.get(file)!;
  const projectFiles = new Map<string, string[]>();
  for (const [file, project] of projectByFile) {
    const paths = projectFiles.get(project);
    if (paths) paths.push(file); else projectFiles.set(project, [file]);
  }
  const bodies = new Map<string, Body>();
  const owners = new Map<string, string>();
  const bodyNames = new Map<string, string>();
  const names = new Map<string, string[]>();
  const ownEffects = new Map<string, Effect<T>[]>();
  const calls = new Map<string, PerlCall[]>();
  const scopeLoads = new Map<string, PerlLoad[]>();
  const unknownDispatchScopes = new Set<string>();
  const projectEffects = new Map<string, Effect<T>[]>();
  const mutatedNames = new Map<string, Set<string>>();
  const aliases = new Map<string, { file: string; mutation: PerlSymbolMutation }[]>();
  const key = (file: string, name: string) => `${projectOf(file)}\0${name}`;
  for (const [file, facts] of files) {
    const definitions = new Map(facts.definitions.map((definition) => [definition.nodeId, definition]));
    for (const scope of facts.scopes) if (scope.kind !== "block" && scope.kind !== "class") {
      bodies.set(scope.id, { file, scope: scope.id });
      // Unbound callbacks can share an enclosing graph owner. Only an actual
      // definition establishes the owner-to-body relation for a lexical call.
      const definition = definitions.get(scope.ownerNode);
      if ((scope.kind === "sub" || scope.kind === "callback") && definition && definition.range.end === scope.range.end) owners.set(scope.ownerNode, scope.id);
    }
    for (const definition of facts.definitions) {
      const scope = owners.get(definition.nodeId);
      if (!scope || !["package-sub", "lexical-sub", "method"].includes(definition.kind)) continue;
      bodyNames.set(scope, definition.qualifiedName);
      for (const name of new Set([definition.name, definition.qualifiedName])) {
        const id = key(file, name);
        names.set(id, [...names.get(id) ?? [], scope]);
      }
    }
    const effects: Effect<T>[] = select(facts).filter((fact) => fact.phase !== "compile" && fact.phase !== "BEGIN" && !perlFileExecution(facts, fact.scopeId)).map((fact) => ({ file, fact }));
    for (const load of facts.loads) if (load.phase !== "compile" && load.phase !== "BEGIN" && !perlFileExecution(facts, load.scopeId) && load.targetKind !== "version" && load.targetKind !== "pragma") {
      const scope = perlExecutionScope(facts, load.scopeId);
      scopeLoads.set(scope, [...scopeLoads.get(scope) ?? [], load]);
      if (load.target.kind === "unknown") {
        if (unknownLoad) effects.push({ file, fact: unknownLoad(load) });
        else unknownDispatchScopes.add(scope);
      }
    }
    for (const effect of effects) {
      const scope = perlExecutionScope(facts, effect.fact.scopeId);
      ownEffects.set(scope, [...ownEffects.get(scope) ?? [], effect]);
    }
    const project = projectOf(file);
    if (!mutatedNames.has(project)) mutatedNames.set(project, new Set());
    for (const mutation of facts.mutations) if (mutation.names.kind === "known") for (const name of mutation.names.value) {
      mutatedNames.get(project)!.add(name);
      if (mutation.aliasReference || mutation.replacementNodeId) for (const spelling of new Set([name, name.slice(name.lastIndexOf("::") + 2)])) {
        const id = key(file, spelling);
        aliases.set(id, [...aliases.get(id) ?? [], { file, mutation }]);
      }
    }
    projectEffects.set(project, [...projectEffects.get(project) ?? [], ...effects, ...select(facts).filter((fact) => !effects.some((effect) => effect.fact === fact)).map((fact) => ({ file, fact }))]);
    for (const call of facts.calls) if (call.phase !== "compile" && call.phase !== "BEGIN") {
      const scope = perlExecutionScope(facts, call.scopeId);
      calls.set(scope, [...calls.get(scope) ?? [], call]);
    }
    for (const mutation of facts.mutations) if (mutation.names.kind === "unknown" && mutation.mechanism !== "framework") unknownDispatchScopes.add(perlExecutionScope(facts, mutation.scopeId));
  }
  // Name/load candidates stay within an effect project. Verify the remaining
  // lexical-target route before treating its complete effect set as maximal.
  const closedProjects = new Set(projectFiles.keys());
  for (const [file, facts] of files) for (const binding of facts.bindings) if (binding.target.kind === "known" && "nodeId" in binding.target.value) {
    const scope = owners.get(binding.target.value.nodeId), body = scope && bodies.get(scope);
    if (body && projectOf(body.file) !== projectOf(file)) closedProjects.delete(projectOf(file));
  }
  // These are possible bodies, not exact binding proofs. Saved references and
  // replacement closures must receive incoming caller state even when the
  // public resolver cannot yet prove when their slot was installed.
  const namedBodies = (file: string, name: string, seen = new Set<string>()): string[] => {
    const id = `${file}\0name:${name}`;
    if (seen.has(id)) return [];
    const next = new Set(seen).add(id), result = [...names.get(key(file, name)) ?? []];
    if (name.includes("::")) {
      const split = name.lastIndexOf("::");
      for (const binding of symbolEnvironment?.imports.get(`${file}\0${name.slice(0, split)}\0${name.slice(split + 2)}`) ?? []) {
        result.push(...namedBodies(binding.providerFile, `${binding.providerPackage}::${binding.exportedName}`, next));
      }
    }
    for (const alias of aliases.get(key(file, name)) ?? []) {
      const owner = alias.mutation.replacementNodeId && owners.get(alias.mutation.replacementNodeId);
      if (owner) result.push(owner);
      if (alias.mutation.aliasReference) result.push(...referenceBodies(alias.file, alias.mutation.aliasReference, next));
    }
    return [...new Set(result)];
  };
  const bindingBodies = (file: string, binding: PerlBinding, seen = new Set<string>()): string[] => {
    const id = `${file}\0binding:${binding.id}`;
    if (seen.has(id)) return [];
    const owner = binding.target.kind === "known" && "nodeId" in binding.target.value ? owners.get(binding.target.value.nodeId) : undefined;
    return [...owner ? [owner] : [], ...binding.captureReference ? referenceBodies(file, binding.captureReference, new Set(seen).add(id)) : []];
  };
  const referenceBodies = (file: string, reference: PerlReference, seen = new Set<string>()): string[] => {
    if (reference.bindingId) {
      const binding = files.get(file)!.bindings.find(binding => binding.id === reference.bindingId);
      return binding ? bindingBodies(file, binding, seen) : [];
    }
    if (reference.name.kind !== "known") return [];
    const name = reference.name.value.replace(/^&/, "");
    return namedBodies(file, name.includes("::") ? name : `${reference.packageName}::${name}`, seen);
  };
  const computeTargets = (file: string, call: PerlCall): Dispatch => {
    const facts = files.get(file)!;
    if (call.bindingId) {
      const binding = facts.bindings.find((b) => b.id === call.bindingId);
      const owner = binding?.target.kind === "known" && "nodeId" in binding.target.value ? owners.get(binding.target.value.nodeId) : undefined;
      const sameExecution = binding && perlExecutionScope(facts, binding.scopeId) === perlExecutionScope(facts, call.scopeId);
      if (owner && !binding!.invalidations.some((i) => !sameExecution || i.at <= call.range.start)) return { scopes: [owner], dynamic: false };
      return { scopes: binding ? bindingBodies(file, binding) : [], dynamic: true };
    }
    if (call.name.kind === "unknown" || call.form === "dynamic" || call.form === "coderef") return { scopes: [], dynamic: true };
    const name = call.name.value.replace(/^&/, "");
    if (name.startsWith("CORE::")) return { scopes: [], dynamic: false };
    if (call.form === "bare" && call.syntax !== "ampersand" && (call.syntax === "builtin" || PERL_LIST_BUILTINS.has(name)) && !facts.loads.some((load) => load.operation === "use" && load.packageName === call.packageName && load.range.end <= call.range.start && load.arguments.kind === "list" && load.arguments.symbols.includes(name))) return { scopes: [], dynamic: false };
    let qualified = name.includes("::") ? name : `${call.packageName}::${name}`;
    const receiver = call.form === "method" ? call.receiver : undefined;
    if (symbolEnvironment && receiver && "packageName" in receiver && !name.includes("::")) qualified = `${receiver.packageName}::${name}`;
    const aliases = symbolEnvironment ? mutatedNames.get(projectOf(file))?.has(qualified) ?? false
      : facts.mutations.some((mutation) => mutation.names.kind === "known" && mutation.names.value.includes(qualified));
    const unknownAlias = facts.mutations.some((mutation) => mutation.names.kind === "unknown" && mutation.mechanism !== "framework" && (perlFileExecution(facts, mutation.scopeId) || perlExecutionScope(facts, mutation.scopeId) === perlExecutionScope(facts, call.scopeId)));
    const escapedCallback = facts.bindings.some((binding) => binding.kind === "lexical-coderef" && binding.invalidations.some((invalidation) => invalidation.reason === "escape" && invalidation.at >= call.range.start && invalidation.at <= call.range.end));
    // Bare/imported names and method names can refer to more than one package.
    // This index is an over-approximation for side effects, not binding proof.
    let scopes = namedBodies(file, name);
    let directMethod = false;
    if (symbolEnvironment) {
      const own = namedBodies(file, qualified);
      if (call.form !== "method") {
        // A source-backed local or standard-imported spelling is stronger
        // evidence than an unrelated same-named body elsewhere in the project.
        if (own.length) scopes = own;
      } else if (receiver && "packageName" in receiver && own.length) { scopes = [...own]; directMethod = true; }
    }
    if (call.form === "method" && !directMethod) scopes.push(...names.get(key(file, "AUTOLOAD")) ?? []);
    else if (!names.has(key(file, qualified))) scopes.push(...names.get(key(file, `${qualified.slice(0, qualified.lastIndexOf("::"))}::AUTOLOAD`)) ?? []);
    return { scopes, dynamic: aliases || unknownAlias || escapedCallback };
  };
  const targetMemo = new WeakMap<PerlCall, Dispatch>();
  const targets = (file: string, call: PerlCall): Dispatch => {
    let result = targetMemo.get(call);
    if (!result) { result = computeTargets(file, call); targetMemo.set(call, result); }
    return result;
  };
  const loadMemo = new WeakMap<PerlLoad, string[]>();
  const loadCandidates = (file: string, load: PerlLoad): string[] => {
    if (load.target.kind === "unknown" || load.targetKind === "version" || load.targetKind === "pragma") return [];
    const cached = loadMemo.get(load);
    if (cached) return cached;
    const request = load.targetKind === "module" ? load.target.value.replaceAll("::", "/") + ".pm" : load.target.value.replace(/^\.\//, "");
    // All matching roots are retained. These candidates can only invalidate
    // state; the ordered module resolver still decides actual load identity.
    const matching = (projectFiles.get(projectOf(file)) ?? []).filter((candidate) => request.includes("..") || candidate === request || candidate.endsWith(`/${request}`) || request.endsWith(`/${candidate}`));
    const resolved = symbolEnvironment?.loads.get(load.id);
    const result = [...new Set([...matching, ...additionalLoadCandidates?.(file, load) ?? [], ...resolved ? [resolved.file] : []])]
      .filter(candidate => files.has(candidate) && projectOf(candidate) === projectOf(file));
    loadMemo.set(load, result);
    return result;
  };
  const summarize = (file: string, seeds: string[], dynamic = false, loadedFiles: string[] = [], observedLoads?: Set<string>): Effect<T>[] => {
    const complete = closedProjects.has(projectOf(file)) ? projectEffects.get(projectOf(file)) ?? [] : undefined;
    const unknownFiles = (owner: string) => { if (observedLoads) for (const possible of projectFiles.get(projectOf(owner)) ?? []) observedLoads.add(possible); };
    // Dynamic dispatch already admits every effect in a closed project.
    // Further graph traversal can only rediscover those same invalidations.
    if (dynamic) unknownFiles(file);
    if (dynamic && complete) return complete;
    const effects = new Set<Effect<T>>(dynamic ? projectEffects.get(projectOf(file)) : []);
    const pending = [...seeds], seen = new Set<string>();
    const pendingFiles = [...loadedFiles], seenFiles = new Set<string>();
    while (pending.length || pendingFiles.length) {
      if (pendingFiles.length) {
        const loaded = pendingFiles.pop()!;
        if (seenFiles.has(loaded)) continue;
        seenFiles.add(loaded);
        observedLoads?.add(loaded);
        const facts = files.get(loaded)!;
        // Requiring a module executes its initializer. Deferred routines only
        // contribute effects when reached through a call or an import hook.
        const initialized = (fact: PerlContext) => ["compile", "BEGIN", "UNITCHECK"].includes(fact.phase) || perlFileExecution(facts, fact.scopeId);
        for (const fact of select(facts)) if (initialized(fact)) effects.add({ file: loaded, fact });
        for (const load of facts.loads) if (initialized(load)) {
          const candidates = loadCandidates(loaded, load);
          pendingFiles.push(...candidates);
          if (load.target.kind === "unknown") {
            unknownFiles(loaded);
            if (unknownLoad) effects.add({ file: loaded, fact: unknownLoad(load) });
            else {
              if (complete) return complete;
              for (const effect of projectEffects.get(projectOf(loaded)) ?? []) effects.add(effect);
            }
          } else if (load.operation !== "require" && load.arguments.kind !== "empty") {
            for (const candidate of candidates) pending.push(...importSeeds(candidate, load.target.value, load.operation === "no" ? "unimport" : "import"));
          }
        }
        for (const call of facts.calls) if (initialized(call)) {
          const next = targets(loaded, call);
          if (next.dynamic) unknownFiles(loaded);
          if (next.dynamic && complete) return complete;
          pending.push(...next.scopes, ...callbacks(loaded, call));
          if (next.dynamic) for (const effect of projectEffects.get(projectOf(loaded)) ?? []) effects.add(effect);
        }
        continue;
      }
      const scope = pending.pop()!;
      if (seen.has(scope)) continue;
      seen.add(scope);
      for (const effect of ownEffects.get(scope) ?? []) effects.add(effect);
      const body = bodies.get(scope);
      if (!body) continue;
      if (unknownDispatchScopes.has(scope)) {
        unknownFiles(body.file);
        if (complete) return complete;
        for (const effect of projectEffects.get(projectOf(body.file)) ?? []) effects.add(effect);
      }
      for (const load of scopeLoads.get(scope) ?? []) {
        pendingFiles.push(...loadCandidates(body.file, load));
        if (load.target.kind === "unknown") unknownFiles(body.file);
      }
      for (const call of calls.get(scope) ?? []) {
        const next = targets(body.file, call);
        if (next.dynamic) unknownFiles(body.file);
        if (next.dynamic && complete) return complete;
        pending.push(...next.scopes, ...callbacks(body.file, call));
        if (next.dynamic) for (const effect of projectEffects.get(projectOf(body.file)) ?? []) effects.add(effect);
      }
    }
    return [...effects];
  };
  const callbackMemo = new WeakMap<PerlCall, string[]>();
  const callbacks = (file: string, call: PerlCall): string[] => {
    const cached = callbackMemo.get(call);
    if (cached) return cached;
    const facts = files.get(file)!;
    const contained = (range: { start: number; end: number }) => range.start >= call.range.start && range.end <= call.range.end;
    const scopes = facts.scopes.filter((scope) => scope.kind === "callback" && contained(scope.range)).map((scope) => scope.id);
    for (const reference of facts.references) if (reference.form === "named-coderef" && contained(reference.range)) scopes.push(...referenceBodies(file, reference));
    // Escaping loses exact binding proof, but a known source callback remains
    // a possible invocation and must receive the caller's mutation state.
    for (const binding of facts.bindings) if (binding.kind === "lexical-coderef"
      && binding.invalidations.some((invalidation) => invalidation.reason === "escape" && invalidation.at >= call.range.start && invalidation.at <= call.range.end)) {
      scopes.push(...bindingBodies(file, binding));
    }
    callbackMemo.set(call, scopes);
    return scopes;
  };
  const memo = new WeakMap<PerlCall, Effect<T>[]>();
  const forCall = (file: string, call: PerlCall): Effect<T>[] => {
    const cached = memo.get(call);
    if (cached) return cached;
    const next = targets(file, call);
    const result = summarize(file, [...next.scopes, ...callbacks(file, call)], next.dynamic);
    memo.set(call, result);
    return result;
  };
  const importMemo = new Map<string, Effect<T>[]>();
  const importScopeMemo = new Map<string, string[]>();
  const importSeeds = (file: string, packageName: string, operation: "import" | "unimport"): string[] => {
    const memoKey = key(file, `${packageName}::${operation}`);
    const cached = importScopeMemo.get(memoKey);
    if (cached) return cached;
    const pending = [packageName], seen = new Set<string>(), seeds: string[] = [];
    while (pending.length) {
      const name = pending.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const own = namedBodies(file, `${name}::${operation}`);
      seeds.push(...own);
      if (own.length) continue;
      for (const [owner, facts] of files) if (projectOf(owner) === projectOf(file)) for (const inheritance of facts.inheritance) if (inheritance.packageName === name) {
        if (inheritance.parents.kind === "known") pending.push(...inheritance.parents.value);
        else seeds.push(...names.get(key(file, operation)) ?? []);
      }
    }
    importScopeMemo.set(memoKey, seeds);
    return seeds;
  };
  const forImport = (file: string, packageName: string, operation: "import" | "unimport"): Effect<T>[] => {
    const memoKey = key(file, `${packageName}::${operation}`);
    const cached = importMemo.get(memoKey);
    if (cached) return cached;
    const result = summarize(file, importSeeds(file, packageName, operation));
    importMemo.set(memoKey, result);
    return result;
  };
  const lifecycleMemo = new Map<string, Effect<T>[]>();
  const lifecycleScopes = new Map([...files].map(([file, facts]) => [file, [...new Set([...select(facts), ...facts.calls, ...facts.loads]
    .filter(fact => fact.phase === "CHECK" || fact.phase === "INIT").map(fact => perlExecutionScope(facts, fact.scopeId)))]]));
  const lifecycleProjects = new Set([...lifecycleScopes].filter(([, scopes]) => scopes.length).map(([file]) => projectOf(file)));
  const lifecycleResults = new Map<string, Effect<T>[]>();
  const forLifecycle = (file: string, loaded = true): Effect<T>[] => {
    if (!lifecycleProjects.size || closedProjects.has(projectOf(file)) && !lifecycleProjects.has(projectOf(file))) return [];
    const memoKey = `${file}\0${loaded}`;
    const cached = lifecycleMemo.get(memoKey);
    if (cached) return cached;
    const scopes = new Set<string>(), compiledFiles = new Set([file]), seeds: string[] = [], loadedFiles: string[] = [];
    const facts = files.get(file)!;
    const compiling = (fact: PerlContext) => ["compile", "BEGIN", "UNITCHECK"].includes(fact.phase) || loaded && perlFileExecution(facts, fact.scopeId);
    let dynamic = false;
    for (const call of facts.calls) if (compiling(call)) {
      const target = targets(file, call);
      dynamic ||= target.dynamic;
      seeds.push(...target.scopes, ...callbacks(file, call));
    }
    for (const load of facts.loads) if (compiling(load)) {
      const candidates = loadCandidates(file, load);
      loadedFiles.push(...candidates);
      if (load.target.kind === "unknown") dynamic = true;
      else if (load.operation !== "require" && load.arguments.kind !== "empty") for (const candidate of candidates) seeds.push(...importSeeds(candidate, load.target.value, load.operation === "no" ? "unimport" : "import"));
    }
    // A BEGIN call can require another module through an ordinary routine.
    // Record those loaded files before collecting their CHECK/INIT blocks.
    summarize(file, seeds, dynamic, loadedFiles, compiledFiles);
    for (const current of compiledFiles) for (const scope of lifecycleScopes.get(current) ?? []) scopes.add(scope);
    // Many entries reach the same CHECK/INIT set. Share its effect closure
    // rather than traversing those bodies again for every loading file.
    const scopeKey = `${projectOf(file)}\0${[...scopes].sort().join("\0")}`;
    let result = lifecycleResults.get(scopeKey);
    if (!result) { result = summarize(file, [...scopes]); lifecycleResults.set(scopeKey, result); }
    lifecycleMemo.set(memoKey, result);
    return result;
  };
  const loadedFileMemo = new Map<string, Effect<T>[]>();
  const forLoad = (file: string): Effect<T>[] => {
    let effects = loadedFileMemo.get(file);
    if (!effects) { effects = summarize(file, [], false, [file]); loadedFileMemo.set(file, effects); }
    return effects;
  };
  // Direct source invocation candidates are for effect propagation only. They
  // deliberately include competing bodies and callbacks, never prove edges.
  const invocationScopes = (file: string, call: PerlCall) => [...targets(file, call).scopes, ...callbacks(file, call)];
  const unknownInvocationMemo = new WeakMap<PerlCall, { unknown: boolean; names: string[] }>();
  const invocation = (file: string, call: PerlCall): { unknown: boolean; names: string[] } => {
    const cached = unknownInvocationMemo.get(call);
    if (cached !== undefined) return cached;
    const pending = [{ file, call }], seen = new Set<string>();
    let unknown = false;
    const invokedNames = new Set<string>();
    while (pending.length && !unknown) {
      const current = pending.pop()!, next = current.call;
      if (next.name.kind === "known") {
        const name = next.name.value.replace(/^&/, "");
        invokedNames.add(name.includes("::") ? name : `${next.packageName}::${name}`);
      }
      if (next.name.kind === "unknown" || next.form === "dynamic" || next.form === "coderef" && targets(current.file, next).dynamic) { unknown = true; break; }
      for (const scope of invocationScopes(current.file, next)) {
        if (next.form === "method" && bodyNames.has(scope)) invokedNames.add(bodyNames.get(scope)!);
        if (seen.has(scope)) continue;
        seen.add(scope);
        if (unknownDispatchScopes.has(scope)) { unknown = true; break; }
        const body = bodies.get(scope);
        if (body) for (const nested of calls.get(scope) ?? []) pending.push({ file: body.file, call: nested });
      }
    }
    const result = { unknown, names: [...invokedNames] };
    unknownInvocationMemo.set(call, result);
    return result;
  };
  const unknownInvocation = (file: string, call: PerlCall) => invocation(file, call).unknown;
  const invocationNames = (file: string, call: PerlCall) => invocation(file, call).names;
  const importScopes = (file: string, packageName: string, operation: "import" | "unimport") => {
    forImport(file, packageName, operation);
    return importScopeMemo.get(key(file, `${packageName}::${operation}`)) ?? [];
  };
  return { forCall, forImport, forLifecycle, forLoad, invocationScopes, unknownInvocation, invocationNames, importScopes,
    dispatchScopes: (file: string, call: PerlCall) => targets(file, call).scopes };
}
