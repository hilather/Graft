/** Project-owned module lookup with explicit compile/load-path ordering. */
import { posix, relative, isAbsolute } from "node:path";
import type { EffectivePerlConfig, PerlProject } from "./perl-config.js";
import { perlProjectOf } from "./perl-config.js";
import { perlExportNames } from "./perl-exports.js";
import { perlFileExecution } from "./perl-context.js";
import { createPerlLoadEffectResolver } from "./perl-effects.js";
import type { PerlCall, PerlContext, PerlDiagnostic, PerlFileFacts, PerlImportedBinding, PerlIncludeEffect, PerlLoad, PerlModuleEnvironment, PerlModuleTarget } from "./perl-types.js";

export const perlImportKey = (file: string, pkg: string, name = "") => `${file}\0${pkg}\0${name}`;
export const weakerPerlConfidence = (a: PerlModuleTarget["confidence"], b: PerlModuleTarget["confidence"]): PerlModuleTarget["confidence"] => a === "inferred" || b === "inferred" ? "inferred" : "extracted";

interface SearchState {
  roots: { path: string; confidence: PerlModuleTarget["confidence"] }[];
  /** An inferred suffix is unordered; an explicit prepend can still win first. */
  orderedPrefix: number;
  known: boolean;
  cacheKnown: boolean;
  cwd?: string;
  pathMappings?: PerlProject["pathMappings"];
  loaded: Map<string, PerlModuleTarget | null>;
  pendingLifecycle: PerlIncludeEffect[];
  runtimeStarted: boolean;
}
type Event = { type: "load"; fact: PerlLoad } | { type: "include"; fact: PerlIncludeEffect } | { type: "call"; fact: PerlCall };

function copyState(state: SearchState): SearchState { return { ...state, roots: [...state.roots], loaded: new Map(state.loaded), pendingLifecycle: [...state.pendingLifecycle] }; }
function inside(file: string, root: string): boolean { return root === "" || file.startsWith(`${root}/`); }
function relativeLiteral(path: string, cwd: string | undefined, graphRoot?: string, mappings?: PerlProject["pathMappings"]): string | null {
  if (path.includes("\\") || path.includes("\0")) return null;
  if (isAbsolute(path)) {
    const normalized = posix.normalize(path);
    const prefix = Object.keys(mappings ?? {}).filter(prefix => prefix === "/" || normalized === prefix || normalized.startsWith(`${prefix}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (prefix !== undefined) {
      const mapped = posix.join(mappings![prefix], normalized.slice(prefix.length).replace(/^\/+/, ""));
      return mapped === "." ? "" : mapped;
    }
    if (!graphRoot) return null;
    const rel = relative(graphRoot, path).replaceAll("\\", "/");
    return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) ? rel : null;
  }
  if (/^[A-Za-z]:/.test(path) || cwd === undefined) return null;
  const resolved = posix.normalize(posix.join(cwd, path));
  return resolved === ".." || resolved.startsWith("../") ? null : resolved === "." ? "" : resolved;
}

function eventOrder(facts: PerlFileFacts, event: PerlContext): number {
  if (event.phase === "compile") return event.range.start;
  if (event.phase === "BEGIN") {
    // Nested use statements compile before the containing BEGIN executes.
    return facts.scopes.find((s) => s.ownerNode === event.sourceNode && s.kind === "phaser")?.range.end ?? event.range.end;
  }
  if (event.phase === "UNITCHECK") return 900_000_000 - (facts.scopes.find((scope) => scope.ownerNode === event.sourceNode && scope.kind === "phaser")?.range.end ?? event.range.end);
  return 1_000_000_000 + event.range.start;
}

export function buildPerlModuleEnvironment(files: ReadonlyMap<string, PerlFileFacts>, config: EffectivePerlConfig, graphRoot?: string): PerlModuleEnvironment {
  const loads = new Map<string, PerlModuleTarget>();
  const observations = new Map<string, Map<string, PerlModuleTarget | null>>();
  const reasons = new Map<string, string>();
  const diagnostics = new Map<string, PerlDiagnostic>();
  const packageFiles = new Map<string, string[]>();
  const projects = new Map<string, PerlProject>();
  const fileNames = [...files.keys()].sort();
  for (const file of fileNames) {
    projects.set(file, perlProjectOf(file, config) ?? { root: "", includeRoots: ["lib", ""], confidence: "inferred", markers: [] });
    const packages = new Set([...files.get(file)!.packages.map((p) => p.name), ...files.get(file)!.definitions.filter((d) => d.kind === "package-sub" || d.kind === "method" || d.kind === "constant").map((d) => d.packageName)]);
    for (const name of packages) packageFiles.set(name, [...packageFiles.get(name) ?? [], file]);
  }
  const report = (file: string, code: string, message: string, fact?: PerlContext) => {
    const key = `${file}:${code}:${fact?.range.start ?? ""}`;
    diagnostics.set(key, { file, code, message, severity: "warning", ...(fact ? { range: fact.range } : {}) });
  };
  const observe = (load: PerlLoad, target: PerlModuleTarget | null, reason?: string) => {
    if (target && load.trapped) target = { ...target, confidence: "inferred" };
    const values = observations.get(load.id) ?? new Map();
    const key = target?.file ?? "?";
    const previous = values.get(key);
    values.set(key, target && previous ? { ...target, confidence: weakerPerlConfidence(target.confidence, previous.confidence) } : target);
    observations.set(load.id, values);
    if (reason) reasons.set(load.id, reason);
  };
  const choose = (file: string, load: PerlLoad, state: SearchState): { target: PerlModuleTarget | null; reason?: string } => {
    if (load.target.kind !== "known") return { target: null, reason: "computed load target" };
    const request = load.target.value;
    if (load.targetKind === "file" && (request.startsWith("./") || request.startsWith("../") || isAbsolute(request) || /^[A-Za-z]:/.test(request))) {
      const path = relativeLiteral(request, state.cwd, graphRoot, state.pathMappings);
      return path !== null && files.has(path) ? { target: { file: path, root: state.cwd ?? "", confidence: "extracted" } } : { target: null, reason: path === null ? isAbsolute(request) ? "Absolute file path is outside the visible root and has no path mapping" : "file path has no proven analysis CWD or leaves the visible root" : undefined };
    }
    if (!state.known) return { target: null, reason: "load path was changed by an unknown or conditional effect" };
    const suffix = load.targetKind === "module" ? request.replaceAll("::", "/") + ".pm" : request;
    if (suffix.startsWith("/") || suffix.includes("\\") || suffix.split("/").includes("..")) return { target: null, reason: "unsupported module path" };
    const inferred: PerlModuleTarget[] = [];
    for (const [index, root] of state.roots.entries()) {
      const path = posix.join(root.path, suffix);
      if (!files.has(path)) continue;
      if (root.confidence === "inferred" && projects.get(path)?.root !== projects.get(file)?.root) continue;
      const target = { file: path, root: root.path, confidence: root.confidence };
      if (index < state.orderedPrefix) return { target };
      inferred.push(target);
    }
    if (inferred.length === 1) return { target: inferred[0] };
    if (inferred.length > 1) return { target: null, reason: "multiple inferred module roots contain this load" };
    if (projects.get(file)!.confidence === "inferred" && state.orderedPrefix === 0) {
      // A suffix alone cannot infer a module root: RT/URI/base.pm declares
      // RT::URI::base, not the core base adapter. Known include roots above
      // still honor Perl's filename lookup even when the package differs.
      const candidates = fileNames.filter((path) => (path === suffix || path.endsWith(`/${suffix}`))
        && projects.get(path)?.root === projects.get(file)?.root && inside(path, projects.get(file)!.root)
        && (load.targetKind !== "module" || packageFiles.get(request)?.includes(path)));
      if (candidates.length === 1) return { target: { file: candidates[0], root: candidates[0].slice(0, -suffix.length).replace(/\/$/, ""), confidence: "inferred" } };
      if (candidates.length > 1) return { target: null, reason: "multiple scoped layout candidates match this load" };
    }
    return { target: null };
  };
  const applyEffect = (file: string, effect: PerlIncludeEffect, state: SearchState) => {
    if (effect.affectsLoaded) { state.loaded.clear(); state.cacheKnown = false; }
    if (effect.affectsCwd) state.cwd = undefined;
    if (effect.conditional || effect.operation === "unknown" || effect.directories.kind === "unknown") {
      state.known = false;
      report(file, "PERL_INCLUDE_PATH_UNKNOWN", "Cannot establish the ordered load path after this effect", effect);
      return;
    }
    const paths = effect.directories.value.map((path) => relativeLiteral(path, state.cwd, graphRoot, state.pathMappings));
    if (paths.some((path) => path === null)) {
      state.known = false;
      const unresolved = effect.directories.value[paths.findIndex(path => path === null)];
      report(file, "PERL_INCLUDE_PATH_UNKNOWN", isAbsolute(unresolved) ? "Absolute use lib/@INC path is outside the visible root and has no path mapping"
        : state.cwd === undefined ? "Relative use lib/@INC paths require an explicit analysisCwd" : "use lib/@INC path leaves the visible root", effect);
      return;
    }
    const roots = [...new Set(paths as string[])].map((path) => ({ path, confidence: "extracted" as const }));
    if (effect.operation === "replace") { state.roots = roots; state.orderedPrefix = roots.length; state.known = true; }
    else if (effect.operation === "prepend") {
      const survivingPrefix = state.roots.slice(0, state.orderedPrefix).filter((r) => !paths.includes(r.path)).length;
      state.roots = [...roots, ...state.roots.filter((r) => !paths.includes(r.path))];
      state.orderedPrefix = survivingPrefix + roots.length;
    } else if (effect.operation === "append") {
      const ordered = state.orderedPrefix === state.roots.length;
      state.roots.push(...roots);
      if (ordered) state.orderedPrefix = state.roots.length;
    } else {
      state.orderedPrefix = state.roots.slice(0, state.orderedPrefix).filter((r) => !paths.includes(r.path)).length;
      state.roots = state.roots.filter((r) => !paths.includes(r.path));
    }
  };
  // Explicit search roots can connect otherwise separate distributions. Merge
  // those contexts only for possible side effects; binding and module identity
  // continue to use their original project boundaries and ordered roots.
  const effectProjects = new Map([...projects.values()].map((project) => [project.root, project.root]));
  const effectProject = (root: string): string => {
    const parent = effectProjects.get(root)!;
    if (parent === root) return root;
    const result = effectProject(parent); effectProjects.set(root, result); return result;
  };
  for (const project of new Map([...projects.values()].map((project) => [project.root, project])).values()) if (project.confidence === "extracted") {
    for (const file of fileNames) if ([...project.includeRoots, ...Object.values(project.pathMappings ?? {})].some((root) => file === root || inside(file, root))) effectProjects.set(effectProject(project.root), effectProject(projects.get(file)!.root));
  }
  const effects = createPerlLoadEffectResolver(files, (file) => effectProject(projects.get(file)!.root), (file, load) => {
    if (load.target.kind !== "known" || load.targetKind !== "file") return [];
    const project = projects.get(file)!;
    const path = relativeLiteral(load.target.value, project.analysisCwd, graphRoot, project.pathMappings);
    return path === null ? [] : [path];
  });
  const invalidate = (state: SearchState, effects: readonly PerlIncludeEffect[]) => {
    if (effects.length) state.known = false;
    if (effects.some((effect) => effect.affectsCwd)) state.cwd = undefined;
    if (effects.some((effect) => effect.affectsLoaded)) { state.loaded.clear(); state.cacheKnown = false; }
  };
  const events = new Map<string, Event[]>();
  for (const [file, facts] of files) events.set(file, [
    ...facts.loads.filter((l) => l.targetKind !== "version" && l.targetKind !== "pragma").map((fact): Event => ({ type: "load", fact })),
    ...facts.includeEffects.map((fact): Event => ({ type: "include", fact })),
    ...facts.calls.filter((fact) => ["compile", "BEGIN", "UNITCHECK"].includes(fact.phase) || perlFileExecution(facts, fact.scopeId)).map((fact): Event => ({ type: "call", fact })),
  ].sort((a, b) => eventOrder(facts, a.fact) - eventOrder(facts, b.fact) || a.fact.range.start - b.fact.range.start));
  const visit = (file: string, state: SearchState, active: Set<string>): void => {
    if (active.has(file)) return;
    const entry = active.size === 0;
    active.add(file);
    const facts = files.get(file)!;
    if (!state.runtimeStarted) state.pendingLifecycle.push(...effects.forLifecycle(file, !entry).map((effect) => effect.fact));
    for (const event of events.get(file) ?? []) {
      const fact = event.fact;
      // CHECK/INIT belong to the main program's phase transition. A module's
      // runtime body can execute inside a caller's BEGIN before that transition.
      if (entry && !state.runtimeStarted && !["compile", "BEGIN", "UNITCHECK"].includes(fact.phase)) {
        state.runtimeStarted = true;
        invalidate(state, state.pendingLifecycle);
        state.pendingLifecycle = [];
      }
      const deferred = fact.phase !== "compile" && fact.phase !== "BEGIN" && fact.phase !== "UNITCHECK" && !perlFileExecution(facts, fact.scopeId);
      if (event.type === "call") {
        if (!deferred) invalidate(state, effects.forCall(file, event.fact).map((effect) => effect.fact));
        continue;
      }
      if (event.type === "include") {
        if (!deferred) applyEffect(file, event.fact, state);
        continue;
      }
      const load = event.fact;
      if (load.viaLoadId && [...observations.get(load.viaLoadId)?.values() ?? []].some((target) => target !== null)) {
        observe(load, null, "Local source shadows the standard inheritance adapter");
        continue;
      }
      // A routine's future load is observed conservatively in a private state.
      // Merely declaring that routine does not execute its mutations while the
      // containing module is initialized.
      const contextState = deferred ? copyState(state) : state;
      if (deferred) invalidate(contextState, facts.includeEffects.filter((effect) => effect.phase !== "compile" && effect.phase !== "BEGIN" && !perlFileExecution(facts, effect.scopeId)));
      const requestKey = load.target.kind === "known" ? load.targetKind === "module" ? load.target.value.replaceAll("::", "/") + ".pm" : load.target.value : null;
      const cached = requestKey !== null && load.operation !== "do" && contextState.loaded.has(requestKey);
      const chosen = !contextState.cacheKnown && load.operation !== "do" ? { target: null, reason: "%INC was mutated; loaded module identity is unknown" } : cached ? { target: contextState.loaded.get(requestKey!)! } : choose(file, load, contextState);
      observe(load, chosen.target, chosen.reason);
      const optional = deferred || load.conditional;
      const next = optional ? copyState(contextState) : state;
      if (requestKey !== null && load.operation !== "do") next.loaded.set(requestKey, chosen.target);
      if (!chosen.target) {
        if (optional && !deferred && requestKey !== null && load.operation !== "do") state.loaded.set(requestKey, null);
        continue;
      }
      const before = JSON.stringify([state.roots, state.known, state.cwd, state.cacheKnown]);
      if (!cached) visit(chosen.target.file, next, active);
      if ((load.operation === "use" || load.operation === "no") && load.arguments.kind !== "empty" && load.target.kind === "known") {
        invalidate(next, effects.forImport(chosen.target.file, load.target.value, load.operation === "use" ? "import" : "unimport").map((effect) => effect.fact));
      }
      if (optional && !deferred) {
        state.pendingLifecycle = [...new Set([...state.pendingLifecycle, ...next.pendingLifecycle])];
        if (JSON.stringify([next.roots, next.known, next.cwd, next.cacheKnown]) !== before) state.known = false;
        if (next.cwd !== state.cwd) state.cwd = undefined;
        if (!next.cacheKnown) state.cacheKnown = false;
        for (const [key, target] of next.loaded) if (state.loaded.get(key)?.file !== target?.file) state.loaded.set(key, null);
      }
    }
    active.delete(file);
  };
  for (const file of fileNames) {
    const project = projects.get(file)!;
    const state: SearchState = { roots: project.includeRoots.map((path) => ({ path, confidence: project.confidence })), orderedPrefix: project.confidence === "extracted" ? project.includeRoots.length : 0, known: true, cacheKnown: true, cwd: project.analysisCwd, pathMappings: project.pathMappings, loaded: new Map(), pendingLifecycle: [], runtimeStarted: false };
    visit(file, state, new Set());
  }
  for (const [file, facts] of files) for (const load of facts.loads) {
    const candidates = observations.get(load.id);
    if (candidates?.size === 1 && !candidates.has("?")) loads.set(load.id, [...candidates.values()][0]!);
    else if (reasons.has(load.id) || (candidates && candidates.size > 1)) report(file, "PERL_MODULE_UNRESOLVED", candidates && candidates.size > 1 ? "Different load contexts select different module files" : reasons.get(load.id)!, load);
  }
  const direct = new Map<string, Map<string, PerlModuleTarget["confidence"]>>();
  for (const [file, facts] of files) {
    const targets = new Map<string, PerlModuleTarget["confidence"]>([[file, "extracted"]]);
    for (const load of facts.loads) {
      const target = loads.get(load.id);
      if (target && !load.conditional && (load.phase === "compile" || load.phase === "BEGIN" || perlFileExecution(facts, load.scopeId))) targets.set(target.file, weakerPerlConfidence(targets.get(target.file) ?? "extracted", target.confidence));
    }
    direct.set(file, targets);
  }
  const reachability = new Map<string, Map<string, PerlModuleTarget["confidence"]>>();
  for (const file of fileNames) {
    const reachable = new Map<string, PerlModuleTarget["confidence"]>([[file, "extracted"]]);
    const pending: [string, PerlModuleTarget["confidence"]][] = [[file, "extracted"]];
    while (pending.length) {
      const [current, confidence] = pending.pop()!;
      for (const [target, edge] of direct.get(current) ?? []) {
        const next = weakerPerlConfidence(confidence, edge);
        if (reachable.has(target) && !(reachable.get(target) === "inferred" && next === "extracted")) continue;
        reachable.set(target, next); pending.push([target, next]);
      }
    }
    reachability.set(file, reachable);
  }
  const imports = new Map<string, PerlImportedBinding[]>();
  const unknownImports = new Set<string>();
  const unknownImportLoads = new Map<string, string[]>();
  const unknownImport = (key: string, loadId: string): void => {
    unknownImports.add(key);
    const ids = unknownImportLoads.get(key) ?? [];
    if (!ids.includes(loadId)) ids.push(loadId);
    unknownImportLoads.set(key, ids);
  };
  for (const [file, facts] of files) for (const load of [...facts.loads].sort((a, b) => eventOrder(facts, a) - eventOrder(facts, b))) {
    if (load.targetKind !== "module" || load.target.kind !== "known" || (load.operation !== "use" && load.operation !== "no")) continue;
    const module = load.target.value;
    if (["Exporter", "parent", "base", "Moo", "Moose", "Moo::Role", "Moose::Role"].includes(module)) continue;
    const packageKey = perlImportKey(file, load.packageName);
    if (load.operation === "no") {
      if (load.arguments.kind === "empty") continue;
      for (const [key, bindings] of imports) if (key.startsWith(packageKey) && bindings.some((b) => b.providerPackage === module)) { imports.delete(key); unknownImport(key, load.id); }
      if (load.arguments.kind === "list") for (const name of load.arguments.symbols) unknownImport(name.startsWith(":") ? packageKey : perlImportKey(file, load.packageName, name.replace(/^&/, "")), load.id);
      else unknownImport(packageKey, load.id);
      continue;
    }
    if (load.arguments.kind === "empty") continue;
    const target = loads.get(load.id);
    const exported = target ? perlExportNames(files.get(target.file)!, module, load.arguments) : null;
    if (!target || !exported || exported.kind === "unknown") {
      if (load.arguments.kind === "list") for (const name of load.arguments.symbols) unknownImport(name.startsWith(":") ? packageKey : perlImportKey(file, load.packageName, name.replace(/^&/, "")), load.id);
      else unknownImport(packageKey, load.id);
      // External imports remain strings in the graph; only unresolved in-repo
      // bindings and explicit unknown argument forms need a coverage warning.
      if (target || load.arguments.kind === "unknown") report(file, "PERL_IMPORT_BINDING_UNKNOWN", exported?.kind === "unknown" ? exported.reason : "Imported names cannot be established", load);
      continue;
    }
    for (const name of exported.value) {
      const key = perlImportKey(file, load.packageName, name);
      const binding: PerlImportedBinding = { file, packageName: load.packageName, name, providerFile: target.file, providerPackage: module, exportedName: name, confidence: target.confidence, loadId: load.id };
      imports.set(key, [...imports.get(key) ?? [], binding]);
    }
  }
  return { loads, packageFiles, reachability, reachableFiles: new Map([...reachability].map(([file, reached]) => [file, new Set(reached.keys())])), imports, unknownImports, unknownImportLoads, unresolved: [...diagnostics.values()].sort((a, b) => a.file.localeCompare(b.file) || (a.range?.start ?? 0) - (b.range?.start ?? 0) || a.code.localeCompare(b.code)) };
}
