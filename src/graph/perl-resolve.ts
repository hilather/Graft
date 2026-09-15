/** Perl binding resolution never enters the generic name/suffix fallback. */
import type { EdgeV1, NodeV1 } from "./types.js";
import type { PerlBinding, PerlCall, PerlContext, PerlDefinition, PerlDiagnostic, PerlFileFacts, PerlModuleEnvironment, PerlModuleTarget, PerlReference, PerlScope } from "./perl-types.js";
import { perlImportKey, weakerPerlConfidence } from "./perl-modules.js";
import { PERL_LIST_BUILTINS } from "./perl-syntax.js";
import { createPerlInheritanceResolver } from "./perl-inheritance.js";
import { createPerlPackageOrder } from "./perl-package-order.js";
import { perlExecutionScope, perlFileExecution } from "./perl-context.js";
import { createPerlInitializationMutations, type PerlMutationState } from "./perl-mutations.js";
import { createPerlCaptureContext } from "./perl-capture-context.js";

type Confidence = PerlModuleTarget["confidence"];
interface Candidate { nodeId: string; confidence: Confidence }
interface Resolution { candidates: Candidate[]; unknown: boolean }
const packageKinds = new Set<PerlDefinition["kind"]>(["package-sub", "method", "constant"]);

function compileEffectPosition(facts: PerlFileFacts, context: PerlContext): number | undefined {
  if (context.phase === "compile") return context.range.end;
  if (context.phase !== "BEGIN") return undefined;
  const scope = perlExecutionScope(facts, context.scopeId);
  return facts.scopes.find((candidate) => candidate.id === scope)?.range.end ?? context.range.end;
}

function inlineConstantCandidate(facts: PerlFileFacts, definition: PerlDefinition, site: PerlCall, compileCalls: WeakMap<PerlFileFacts, number[]>): boolean {
  if (!definition.inlineConstant || !definition.hasBody || definition.conditional
    || site.syntax === "ampersand" || !(site.syntax === "bareword" || site.emptyArguments)
    || definition.range.end > site.range.start) return false;
  if (facts.diagnostics.some(diagnostic => ["PERL_PARSE_ERROR", "PERL_OPAQUE_RECOVERY", "PERL_EMBEDDED_CODE_UNSUPPORTED"].includes(diagnostic.code))) return false;
  if (facts.mutations.some(mutation => {
    if (mutation.names.kind === "known" && !mutation.names.value.includes(definition.qualifiedName)) return false;
    const at = compileEffectPosition(facts, mutation);
    return at !== undefined && at > definition.range.end && at <= site.range.start;
  })) return false;
  let positions = compileCalls.get(facts);
  if (!positions) {
    positions = [...facts.calls, ...facts.loads.filter(load => load.targetKind !== "pragma" && load.targetKind !== "version")]
      .map(context => compileEffectPosition(facts, context)).filter((at): at is number => at !== undefined).sort((a, b) => a - b);
    compileCalls.set(facts, positions);
  }
  // A BEGIN/helper, module initializer, or import can replace a constant or its
  // prototype before this call is compiled. No purity is assumed. Locate the
  // first such effect after the declaration without rescanning every call.
  let low = 0, high = positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (positions[middle] <= definition.range.end) low = middle + 1;
    else high = middle;
  }
  return low === positions.length || positions[low] > site.range.start;
}

export function resolvePerlEdges(nodes: readonly NodeV1[], files: ReadonlyMap<string, PerlFileFacts>, environment: PerlModuleEnvironment): { edges: EdgeV1[]; diagnostics: PerlDiagnostic[] } {
  const byId = new Map(nodes.filter((n) => n.language === "perl").map((n) => [n.id, n]));
  const packageOrder = createPerlPackageOrder(files, environment);
  const inheritance = createPerlInheritanceResolver(files, environment, packageOrder);
  let initializationMutations: ReturnType<typeof createPerlInitializationMutations> | undefined;
  const capturedInLoader = createPerlCaptureContext(files, environment, packageOrder,
    () => initializationMutations ??= createPerlInitializationMutations(files, environment));
  const hasMutations = [...files.values()].some((facts) => facts.mutations.length);
  const definitions = new Map<string, Map<string, PerlDefinition[]>>();
  const mutationFiles = new Map([...files].flatMap(([file, facts]) => facts.mutations.map(mutation => [mutation, file] as const)));
  const aliasNames = new Set([...mutationFiles.keys()].flatMap(mutation => (mutation.aliasReference || mutation.replacementNodeId) && mutation.names.kind === "known" ? mutation.names.value : []));
  const compileCalls = new WeakMap<PerlFileFacts, number[]>();
  const bindingIndexes = new WeakMap<PerlFileFacts, Map<string, PerlBinding>>();
  const scopeIndexes = new WeakMap<PerlFileFacts, Map<string, PerlScope>>();
  for (const [file, facts] of files) {
    const names = new Map<string, PerlDefinition[]>();
    for (const definition of facts.definitions) if (packageKinds.has(definition.kind)) names.set(definition.qualifiedName, [...names.get(definition.qualifiedName) ?? [], definition]);
    definitions.set(file, names);
    bindingIndexes.set(facts, new Map(facts.bindings.map((binding) => [binding.id, binding])));
    scopeIndexes.set(facts, new Map(facts.scopes.map((scope) => [scope.id, scope])));
  }
  const edges = new Map<string, EdgeV1>();
  const diagnostics = new Map<string, PerlDiagnostic>();
  for (const diagnostic of environment.unresolved) diagnostics.set(`${diagnostic.file}:${diagnostic.code}:${diagnostic.range?.start ?? ""}`, diagnostic);
  const report = (file: string, site: PerlContext, code: string, message: string) => {
    diagnostics.set(`${file}:${code}:${site.range.start}`, { file, code, message, range: site.range, severity: "warning" });
  };
  const add = (source: string, target: string, relation: EdgeV1["relation"], confidence: Confidence) => {
    if (!byId.has(source) || (relation !== "imports" && !byId.has(target))) return;
    const key = `${source}\0${relation}\0${target}`;
    const previous = edges.get(key);
    // Independent proven paths may strengthen an otherwise inferred edge.
    if (!previous || (previous.confidence === "inferred" && confidence === "extracted")) edges.set(key, { source, target, relation, confidence });
  };
  const reachableAt = (file: string, site: PerlContext): Map<string, Confidence> => {
    const reachable = new Map<string, Confidence>([[file, "extracted"]]);
    const facts = files.get(file)!;
    if (packageOrder.deferred(file, site)) {
      const entry = packageOrder.entry(file, site.packageName);
      if (entry !== file) for (const other of environment.reachability.get(entry)?.keys() ?? []) {
        if (other !== file) reachable.set(other, "inferred");
      }
    }
    for (const load of facts.loads) {
      if (load.conditional) continue;
      const compile = load.phase === "compile" || load.phase === "BEGIN";
      const earlySite = site.phase === "compile" || site.phase === "BEGIN";
      const adapterReference = load.implicit === "framework" && "form" in site && site.form === "role" && load.range.start === site.range.start && load.range.end === site.range.end;
      const available = adapterReference || (earlySite ? compile && load.range.end <= site.range.start
        : compile || (perlFileExecution(facts, load.scopeId) && (!perlFileExecution(facts, site.scopeId) || load.range.end <= site.range.start)) || (perlExecutionScope(facts, load.scopeId) === perlExecutionScope(facts, site.scopeId) && load.range.end <= site.range.start));
      const target = available ? environment.loads.get(load.id) : undefined;
      if (!target) continue;
      for (const [other, confidence] of environment.reachability.get(target.file) ?? [[target.file, "extracted" as const]]) {
        const next = weakerPerlConfidence(target.confidence, confidence);
        if (!reachable.has(other) || next === "extracted") reachable.set(other, next);
      }
    }
    return reachable;
  };
  const composedMutation = (packageName: string, bare: string, reached: ReadonlyMap<string, Confidence>, seen = new Set<string>()): boolean => {
    if (seen.has(packageName)) return true;
    const next = new Set(seen).add(packageName);
    for (const file of reached.keys()) for (const composition of files.get(file)?.frameworks ?? []) {
      if (composition.packageName !== packageName || composition.declaration !== "with") continue;
      if (composition.names.kind === "unknown") return true;
      for (const role of composition.names.value) {
        const owners = (environment.packageFiles.get(role) ?? []).filter((owner) => reached.has(owner));
        if (owners.length !== 1) return true;
        const facts = files.get(owners[0])!;
        if (!facts.packages.some((p) => p.name === role && p.kind === "role")) return true;
        if (facts.mutations.some((m) => m.names.kind === "known" ? m.names.value.includes(`${role}::${bare}`) : m.packageName === role)) return true;
        if (composedMutation(role, bare, reached, next)) return true;
      }
    }
    return false;
  };
  const packageCandidates = (file: string, name: string, reached: ReadonlyMap<string, Confidence>, seen = new Set<string>(), earlyPosition?: number, ignoreFrameworkMutations = false, site?: PerlContext, captured?: PerlMutationState): Resolution => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return { candidates: [], unknown: true };
    if (!captured && site && "form" in site && site.form === "named-coderef") {
      const target = capturedInLoader(file, site, name);
      if (target !== undefined) return target && byId.has(target)
        ? { candidates: [{ nodeId: target, confidence: "inferred" }], unknown: false } : { candidates: [], unknown: true };
    }
    const nextSeen = new Set(seen).add(key);
    const split = name.lastIndexOf("::");
    const packageName = name.slice(0, split), bare = name.slice(split + 2);
    const result: Resolution = { candidates: [], unknown: composedMutation(packageName, bare, reached) };
    const state = captured ?? (site && hasMutations ? (initializationMutations ??= createPerlInitializationMutations(files, environment)).at(file, site) : undefined);
    const inlineSite = site && "form" in site && (site.form === "bare" || site.form === "qualified") ? site as PerlCall : undefined;
    const affects = (mutation: PerlFileFacts["mutations"][number]) => !(ignoreFrameworkMutations && mutation.frameworkEffect === "modifier")
      && (mutation.names.kind === "known" ? mutation.names.value.includes(name) : mutation.mechanism !== "framework" || mutation.packageName === packageName);
    const inferred = state?.excluded.some(affects) ?? false;
    const local = definitions.get(file)?.get(name) ?? [];
    const compiled = inlineSite && local.length === 1 && inlineConstantCandidate(files.get(file)!, local[0], inlineSite, compileCalls);
    // This expression contains the value compiled from the local definition.
    // Later foreign initializers, imports, or reopened declarations can change
    // the callable slot, but cannot retarget an already embedded value.
    if (compiled && byId.has(local[0].nodeId)) return { candidates: [{ nodeId: local[0].nodeId, confidence: reached.get(file) ?? "extracted" }], unknown: false };
    const active = state && aliasNames.has(name) ? [...state.active].filter(affects) : [];
    const alias = active.length === 1 ? active[0] : undefined;
    if (!compiled && !result.unknown && site && !captured && alias && (alias.aliasReference || alias.replacementNodeId)) {
      const aliasFile = mutationFiles.get(alias)!;
      const timeline = packageOrder.timeline(file, site);
      const installed = timeline?.ordered ? timeline.aliases.get(alias) : undefined;
      // The assignment captures a CODE value. Resolve its RHS in the state
      // before installation, not in the state at a later invocation.
      if (installed !== undefined && !timeline!.uncertainDefinitions.has(name)
        && [...reached.keys()].every(owner => (definitions.get(owner)?.get(name) ?? []).every(definition =>
          timeline!.definitions.has(definition.nodeId) && timeline!.definitions.get(definition.nodeId)! < installed))) {
        if (alias.replacementNodeId && byId.has(alias.replacementNodeId)) {
          return { candidates: [{ nodeId: alias.replacementNodeId, confidence: reached.get(aliasFile) ?? "inferred" }], unknown: false };
        }
        const ref = alias.aliasReference!;
        const binding = liveBinding(files.get(aliasFile)!, ref);
        if (binding) {
          const resolution = bindingCandidates(aliasFile, ref, binding, nextSeen);
          return { ...resolution, candidates: resolution.candidates.map(candidate => ({ ...candidate,
            confidence: weakerPerlConfidence(candidate.confidence, reached.get(aliasFile) ?? "inferred") })) };
        }
        if (!ref.bindingId && ref.name.kind === "known") {
          const target = ref.name.value.includes("::") ? ref.name.value : `${ref.packageName}::${ref.name.value}`;
          const resolution = packageCandidates(aliasFile, target, reachableAt(aliasFile, ref), nextSeen,
            ref.phase === "compile" || ref.phase === "BEGIN" ? ref.range.start : undefined, false, ref);
          return { ...resolution, candidates: resolution.candidates.map(candidate => ({ ...candidate,
            confidence: weakerPerlConfidence(candidate.confidence, reached.get(aliasFile) ?? "inferred") })) };
        }
      }
    }
    // Activated unknown code can affect any package, including imported slots.
    // The origin file is not a namespace boundary for eval or dynamic globs.
    if (state && !compiled && [...state.active].some(affects)) result.unknown = true;
    for (const [contextFile, confidence] of reached) {
      const facts = files.get(contextFile);
      if (!facts) continue;
      const own = definitions.get(contextFile)?.get(name) ?? [];
      if (facts.mutations.some(m => affects(m) && (m.mechanism === "framework" || !state || state.active.has(m)))) result.unknown = true;
      // use/no execute while compiling. A later unique source declaration
      // replaces their earlier package binding. Keep runtime mutations above
      // and imports after/inside that declaration conservative.
      const declaration = own.length === 1 && own[0].hasBody && !own[0].conditional ? own[0] : undefined;
      const shadowsImport = (loadId: string): boolean => {
        const load = facts.loads.find((item) => item.id === loadId);
        return !!declaration && !!load && (load.phase === "compile" || load.phase === "BEGIN")
          && load.range.end <= declaration.range.start;
      };
      for (const definition of own) {
        if (!definition.hasBody || definition.conditional || !byId.has(definition.nodeId) || (contextFile === file && earlyPosition !== undefined && definition.range.end > earlyPosition)) result.unknown = true;
        else result.candidates.push({ nodeId: definition.nodeId, confidence: inferred ? "inferred" : confidence });
      }
      const importKey = perlImportKey(contextFile, packageName, bare);
      for (const key of [importKey, perlImportKey(contextFile, packageName)]) if (environment.unknownImports.has(key)) {
        const loadIds = environment.unknownImportLoads?.get(key);
        if (!loadIds?.length || !loadIds.every(shadowsImport)) result.unknown = true;
      }
      for (const binding of environment.imports.get(importKey) ?? []) {
        if (contextFile === file && earlyPosition !== undefined && (facts.loads.find((l) => l.id === binding.loadId)?.range.end ?? Infinity) > earlyPosition) continue;
        const providerReach = environment.reachability.get(binding.providerFile) ?? new Map([[binding.providerFile, "extracted" as const]]);
        const load = facts.loads.find((item) => item.id === binding.loadId);
        let snapshot = load && hasMutations ? (initializationMutations ??= createPerlInitializationMutations(files, environment)).imported(contextFile, load, binding.providerFile) : undefined;
        if (snapshot && captured) {
          // An importing module runs in its loader's current state. Reexports
          // cannot reset mutations that preceded loading the facade.
          const active = new Set([...snapshot.active, ...captured.active]);
          snapshot = { active, excluded: snapshot.excluded.filter((mutation) => !active.has(mutation)) };
        }
        const provider = packageCandidates(binding.providerFile, `${binding.providerPackage}::${binding.exportedName}`, providerReach, nextSeen, undefined, ignoreFrameworkMutations, undefined, snapshot);
        result.unknown ||= provider.unknown;
        for (const candidate of provider.candidates) result.candidates.push({ nodeId: candidate.nodeId, confidence: weakerPerlConfidence(inferred ? "inferred" : confidence, weakerPerlConfidence(binding.confidence, candidate.confidence)) });
      }
    }
    const sourceFile = site ? byId.get(site.sourceNode)?.path ?? file : file;
    const sourceOrder = site ? packageOrder.timeline(sourceFile, site) : null;
    if (sourceOrder?.uncertainDefinitions.has(name)) result.unknown = true;
    // Reopened packages install named subs while their files compile. A
    // resolved load sequence can establish the final implementation, including
    // runtime overlays replacing a declaration in the loading module.
    if (!result.unknown && site && !captured && result.candidates.length > 1) {
      const owners = new Set(result.candidates.map(candidate => byId.get(candidate.nodeId)?.path));
      const timeline = owners.size > 1 ? sourceOrder : null;
      if (timeline?.ordered && result.candidates.every(candidate => timeline.definitions.has(candidate.nodeId))
        && [...owners].every(owner => owner && (definitions.get(owner)?.get(name)?.length ?? 0) === 1)) {
        const winner = result.candidates.reduce((a, b) => timeline.definitions.get(a.nodeId)! > timeline.definitions.get(b.nodeId)! ? a : b);
        const confidence = result.candidates.reduce((value, candidate) => weakerPerlConfidence(value, candidate.confidence), winner.confidence);
        result.candidates = [{ ...winner, confidence }];
      }
    }
    return result;
  };
  const liveBinding = (facts: PerlFileFacts, site: PerlCall | PerlReference): PerlBinding | undefined => {
    if (!site.bindingId) return undefined;
    const binding = bindingIndexes.get(facts)?.get(site.bindingId);
    if (!binding || binding.visibleFrom > site.range.start || binding.visibleUntil <= site.range.start) return undefined;
    const scopes = scopeIndexes.get(facts)!;
    let scope = scopes.get(site.scopeId);
    while (scope) {
      if (scope.id === binding.scopeId) return binding;
      scope = scope.parent ? scopes.get(scope.parent) : undefined;
    }
    return undefined;
  };
  const bindingCandidates = (file: string, site: PerlCall | PerlReference, binding: PerlBinding, seen = new Set<string>()): Resolution => {
    const unresolved: Resolution = { candidates: [], unknown: true };
    const key = `${file}\0binding:${binding.id}`;
    if (seen.has(key)) return unresolved;
    const facts = files.get(file)!;
    const sameExecution = perlExecutionScope(facts, binding.scopeId) === perlExecutionScope(facts, site.scopeId);
    // A closure may run after assignments textually below its definition.
    // Capturing a CODE value freezes its identity, not the captured variable.
    if (binding.invalidations.some(invalidation => !sameExecution || invalidation.at <= site.range.start)) return unresolved;
    const capture = binding.captureReference;
    if (!capture) {
      if (binding.target.kind !== "known" || !("nodeId" in binding.target.value)) return unresolved;
      if (binding.kind === "our-alias" && !binding.name.startsWith("$")) return packageCandidates(file,
        `${binding.packageName}::${binding.name}`, reachableAt(file, site), seen,
        site.phase === "compile" || site.phase === "BEGIN" ? site.range.start : undefined, false, site);
      return { candidates: [{ nodeId: binding.target.value.nodeId, confidence: "extracted" }], unknown: false };
    }
    if (capture.conditional || facts.initializationOrderUnknown || capture.range.end > site.range.start) return unresolved;
    let initialized = sameExecution && capture.phase === site.phase;
    if (!initialized && capture.phase === "runtime" && site.phase === "runtime") {
      // An anonymous routine created after initialization cannot be invoked
      // before its captured value exists. Named subs compile earlier and need
      // the stronger whole-initialization ordering proof below.
      const scopes = scopeIndexes.get(facts)!;
      let scope = scopes.get(perlExecutionScope(facts, site.scopeId));
      while (scope?.kind === "callback" && scope.contextKnown && scope.parent) {
        const parent = perlExecutionScope(facts, scope.parent);
        if (parent === perlExecutionScope(facts, capture.scopeId)) {
          initialized = scope.range.start >= capture.range.end;
          break;
        }
        scope = scopes.get(parent);
      }
      if (!initialized && perlFileExecution(facts, capture.scopeId)) {
        const timeline = packageOrder.timeline(file, site);
        initialized = !!timeline?.ordered && timeline.captures.has(binding);
      }
    }
    if (!initialized) return unresolved;
    const next = new Set(seen).add(key);
    const capturedBinding = liveBinding(facts, capture);
    if (capturedBinding) return bindingCandidates(file, capture, capturedBinding, next);
    if (capture.bindingId || capture.name.kind !== "known") return unresolved;
    const target = capture.name.value.includes("::") ? capture.name.value : `${capture.packageName}::${capture.name.value}`;
    return packageCandidates(file, target, reachableAt(file, capture), next,
      capture.phase === "compile" || capture.phase === "BEGIN" ? capture.range.start : undefined, false, capture);
  };
  const priorBareword = (file: string, site: PerlCall, qualified: string, reached: ReadonlyMap<string, Confidence>): boolean => {
    const split = qualified.lastIndexOf("::"), pkg = qualified.slice(0, split), name = qualified.slice(split + 2);
    for (const contextFile of reached.keys()) {
      if ((definitions.get(contextFile)?.get(qualified) ?? []).some((d) => d.declarations.some((r) => contextFile !== file || r.end <= site.range.start))) return true;
      for (const binding of environment.imports.get(perlImportKey(contextFile, pkg, name)) ?? []) {
        const load = files.get(contextFile)!.loads.find((l) => l.id === binding.loadId);
        if (load && (contextFile !== file || load.range.end <= site.range.start)) return true;
      }
    }
    return false;
  };
  const roleComposition = (name: string, reached: ReadonlyMap<string, Confidence>): boolean => [...reached.keys()].some((file) => files.get(file)?.frameworks.some((fact) => fact.packageName === name && fact.declaration === "with"));
  const methodCandidates = (file: string, site: PerlContext, packageName: string, method: string, reached: ReadonlyMap<string, Confidence>, superCall = false, modifier = false): Resolution => {
    const early = site.phase === "compile" || site.phase === "BEGIN" ? site.range.start : undefined;
    const own = superCall ? { candidates: [], unknown: false } : packageCandidates(file, `${packageName}::${method}`, reached, undefined, early, modifier, site);
    if (own.candidates.length || own.unknown) return own;
    if (!superCall && roleComposition(packageName, reached)) return { candidates: [], unknown: true };
    const order = inheritance.linearize(packageName, reached, { file, context: site });
    const targets = order.kind === "known" ? order.value : /Cyclic|Inconsistent|depth bound/.test(order.reason) ? []
      : inheritance.linearizePrefix(packageName, reached, { file, context: site });
    for (const target of targets.slice(1)) {
      const inherited = packageCandidates(file, `${target.packageName}::${method}`, reached, undefined, early, modifier, site);
      if (inherited.candidates.length || inherited.unknown) return { unknown: inherited.unknown, candidates: inherited.candidates.map((candidate) => ({ ...candidate, confidence: weakerPerlConfidence(candidate.confidence, target.confidence) })) };
      if (roleComposition(target.packageName, reached)) return { candidates: [], unknown: true };
    }
    if (order.kind === "unknown") {
      report(file, site, "PERL_MRO_UNRESOLVED", order.reason);
      return { candidates: [], unknown: true };
    }
    return { candidates: [], unknown: false };
  };
  for (const [file, facts] of files) {
    const reached = environment.reachability.get(file) ?? new Map([[file, "extracted" as const]]);
    for (const name of new Set(facts.inheritance.map((fact) => fact.packageName))) {
      const state = inheritance.state(name, reached);
      const fact = facts.inheritance.find((fact) => fact.packageName === name)!;
      if (state.kind === "unknown") { report(file, fact, "PERL_INHERITANCE_UNRESOLVED", state.reason); continue; }
      if (state.value.parents.some((parent) => parent !== "Exporter")) {
        const order = inheritance.linearize(name, reached);
        if (order.kind === "unknown") report(file, fact, "PERL_MRO_UNRESOLVED", order.reason);
      }
      for (const parent of state.value.parents) {
        const target = inheritance.state(parent, reached);
        if (target.kind === "known" && state.value.target.nodeId && target.value.target.nodeId) add(state.value.target.nodeId, target.value.target.nodeId, "extends", weakerPerlConfidence(state.value.target.confidence, target.value.target.confidence));
        else if (parent !== "Exporter") report(file, fact, "PERL_INHERITANCE_UNRESOLVED", target.kind === "unknown" ? target.reason : `No source package node for ${parent}`);
      }
    }
    for (const load of facts.loads) {
      if (load.targetKind === "version" || load.targetKind === "pragma" || load.target.kind !== "known") continue;
      const target = environment.loads.get(load.id);
      add(file, target?.file ?? load.target.value, "imports", target?.confidence ?? "extracted");
    }
    for (const site of [...facts.calls, ...facts.references]) {
      const relation = ["named-coderef", "role", "modifier"].includes(site.form) ? "references" : "calls";
      if (site.name.kind !== "known" || site.form === "dynamic") {
        report(file, site, "PERL_DYNAMIC_TARGET", "Call or reference has no statically known target"); continue;
      }
      const rawName = site.name.value.replace(/^&/, "");
      if (rawName.startsWith("CORE::")) continue;
      if (site.form === "bare" && site.syntax !== "ampersand" && !site.bindingId && (site.syntax === "builtin" || PERL_LIST_BUILTINS.has(rawName))) {
        const declared = facts.loads.some((l) => l.operation === "use" && l.target.kind === "known" && l.target.value === "subs" && l.packageName === site.packageName && l.arguments.kind === "list" && l.arguments.symbols.includes(rawName) && l.range.end <= site.range.start);
        const imported = (environment.imports.get(perlImportKey(file, site.packageName, rawName)) ?? []).some((b) => {
          const load = facts.loads.find((l) => l.id === b.loadId);
          return load && load.range.end <= site.range.start && load.arguments.kind === "list" && load.arguments.symbols.includes(rawName);
        });
        if (!declared && !imported) continue;
      }
      const reached = reachableAt(file, site);
      const earlyPosition = site.phase === "compile" || site.phase === "BEGIN" ? site.range.start : undefined;
      if ("requiresInlineConstant" in site && site.requiresInlineConstant) {
        const guard = site.requiresInlineConstant;
        const head: PerlCall = { ...site, name: { kind: "known", value: guard.name }, form: "qualified", bindingId: undefined, syntax: undefined, emptyArguments: true, range: { ...site.range, start: guard.position, end: guard.position + guard.name.length } };
        const own = definitions.get(file)?.get(guard.name) ?? [];
        const proof = own.length === 1 && inlineConstantCandidate(facts, own[0], head, compileCalls)
          ? packageCandidates(file, guard.name, reached, undefined, guard.position, false, head) : undefined;
        if (!proof || proof.unknown || proof.candidates.length !== 1 || proof.candidates[0].nodeId !== own[0].nodeId) {
          report(file, site, "PERL_AMBIGUOUS_CALL_SYNTAX", "Unary bareword syntax needs a proven zero-argument constant");
          continue;
        }
      }
      let result: Resolution;
      const binding = liveBinding(facts, site);
      if (site.form === "role") {
        const owners = (environment.packageFiles.get(rawName) ?? []).filter((owner) => reached.has(owner));
        const owner = owners.length === 1 ? owners[0] : undefined;
        const role = owner ? files.get(owner)?.packages.find((p) => p.name === rawName && p.kind === "role") : undefined;
        result = role && owner ? { candidates: [{ nodeId: role.nodeId, confidence: reached.get(owner)! }], unknown: false } : { candidates: [], unknown: true };
      } else if (site.form === "modifier") {
        result = methodCandidates(file, site, site.packageName, rawName, reached, false, true);
      } else if (site.bindingId || site.form === "coderef") {
        result = binding ? bindingCandidates(file, site, binding) : { candidates: [], unknown: true };
      } else if (site.form === "method") {
        let receiver = site.receiver;
        if (receiver?.kind === "lexical") {
          const local = liveBinding(facts, { ...site, bindingId: receiver.bindingId });
          receiver = local && !local.invalidations.some((i) => i.at <= site.range.start) ? local.receiver : undefined;
        }
        let packageName = receiver?.kind === "super" ? receiver.lexicalPackage : receiver && "packageName" in receiver ? receiver.packageName : undefined;
        const superCall = receiver?.kind === "super";
        let method = rawName;
        if (!superCall && method.includes("::")) { const cut = method.lastIndexOf("::"); packageName = method.slice(0, cut); method = method.slice(cut + 2); }
        result = { candidates: [], unknown: true };
        if (packageName) {
          result = methodCandidates(file, site, packageName, method, reached, superCall);
          if (receiver?.kind === "bless" || receiver?.kind === "declared-self") result.candidates = result.candidates.map((candidate) => ({ ...candidate, confidence: "inferred" }));
        }
      } else {
        const qualified = rawName.includes("::") ? rawName : `${site.packageName}::${rawName}`;
        // A grammar bareword alone is also a possible string. Only prior
        // declarations/imports prove that Perl parses it as a call.
        if ("syntax" in site && site.syntax === "bareword" && !priorBareword(file, site, qualified, reached)) continue;
        result = packageCandidates(file, qualified, reached, undefined, earlyPosition, false, site);
      }
      const candidates = new Map<string, Candidate>();
      for (const candidate of result.candidates) {
        const previous = candidates.get(candidate.nodeId);
        if (!previous || candidate.confidence === "extracted") candidates.set(candidate.nodeId, candidate);
      }
      if (!result.unknown && candidates.size === 1) {
        const target = [...candidates.values()][0];
        add(site.sourceNode, target.nodeId, relation, target.confidence);
      } else report(file, site, candidates.size > 1 ? "PERL_BINDING_AMBIGUOUS" : "PERL_TARGET_UNRESOLVED", `Cannot establish one source target for ${rawName}`);
    }
  }
  return { edges: [...edges.values()], diagnostics: [...diagnostics.values()].sort((a, b) => a.file.localeCompare(b.file) || (a.range?.start ?? 0) - (b.range?.start ?? 0) || a.code.localeCompare(b.code)) };
}
