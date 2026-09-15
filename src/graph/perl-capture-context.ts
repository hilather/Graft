/** CODE captures in a loaded overlay observe its loader's state at that point,
 * not the union of effects after the complete module chain has initialized. */
import { perlExecutionScope } from "./perl-context.js";
import { PERL_LIST_BUILTINS } from "./perl-syntax.js";
import type { createPerlPackageOrder } from "./perl-package-order.js";
import type { createPerlInitializationMutations } from "./perl-mutations.js";
import type { PerlCall, PerlContext, PerlFileFacts, PerlModuleEnvironment, PerlSymbolMutation } from "./perl-types.js";

export function createPerlCaptureContext(files: ReadonlyMap<string, PerlFileFacts>, environment: PerlModuleEnvironment,
  order: ReturnType<typeof createPerlPackageOrder>, effects: () => ReturnType<typeof createPerlInitializationMutations>) {
  const scopes = new Map<string, { file: string; calls: PerlCall[]; loads: boolean; overridesBuiltin: boolean }>();
  for (const [file, facts] of files) {
    for (const scope of facts.scopes) scopes.set(scope.id, { file, calls: [], loads: false, overridesBuiltin: false });
    for (const call of facts.calls) if (!["compile", "BEGIN", "UNITCHECK"].includes(call.phase)) scopes.get(perlExecutionScope(facts, call.scopeId))?.calls.push(call);
    for (const load of facts.loads) if (load.targetKind !== "pragma" && load.targetKind !== "version") {
      const scope = scopes.get(perlExecutionScope(facts, load.scopeId));
      if (scope) scope.loads = true;
    }
    for (const mutation of facts.mutations) if (mutation.names.kind === "unknown" || mutation.names.value.some(name => name.startsWith("CORE::GLOBAL::"))) {
      const scope = scopes.get(perlExecutionScope(facts, mutation.scopeId));
      if (scope) scope.overridesBuiltin = true;
    }
  }
  const builtin = (file: string, call: PerlCall, opaqueBuiltins: boolean, overrides: ReadonlySet<string>): boolean => {
    if (call.name.kind !== "known") return false;
    if (/^CORE::\w+$/.test(call.name.value)) return true;
    if (opaqueBuiltins || overrides.has(call.name.value)) return false;
    if (call.form !== "bare" || call.syntax === "ampersand" || !(call.syntax === "builtin" || PERL_LIST_BUILTINS.has(call.name.value))) return false;
    const name = call.name.value, facts = files.get(file)!;
    return !facts.definitions.some(definition => definition.name === name)
      && !facts.loads.some(load => load.operation === "use" && load.arguments.kind === "list" && load.arguments.symbols.includes(name));
  };
  const opaqueCalls = (file: string, call: PerlCall, opaqueBuiltins: boolean, overrides: ReadonlySet<string>): boolean => {
    const pending = [{ file, call }], seen = new Set<string>(), source = effects();
    while (pending.length) {
      const current = pending.pop()!;
      const intrinsic = builtin(current.file, current.call, opaqueBuiltins, overrides);
      if (!intrinsic && (source.unknownInvocation(current.file, current.call) || !source.dispatchScopes(current.file, current.call).length)) return true;
      for (const scope of source.invocationScopes(current.file, current.call)) {
        if (seen.has(scope)) continue;
        seen.add(scope);
        const body = scopes.get(scope);
        if (!body || body.loads || body.overridesBuiltin) return true;
        for (const nested of body.calls) pending.push({ file: body.file, call: nested });
      }
    }
    return false;
  };
  const contexts = new WeakMap<PerlContext, Map<string, string> | null>();
  return (file: string, site: PerlContext, name: string): string | null | undefined => {
    const trace = order.initialization(file, site);
    if (!trace) return undefined;
    let slots = contexts.get(site);
    if (!contexts.has(site)) {
      slots = new Map<string, string>();
      let opaqueBuiltins = false;
      const overrides = new Set<string>();
      const opaque = () => { slots!.clear(); opaqueBuiltins = true; };
      const invalidate = (mutation: PerlSymbolMutation) => {
        if (mutation.names.kind === "unknown") opaque();
        else for (const name of mutation.names.value) {
          slots!.delete(name);
          if (name.startsWith("CORE::GLOBAL::")) overrides.add(name.slice("CORE::GLOBAL::".length));
        }
      };
      for (const { file: owner, event } of trace.events) {
        const facts = files.get(owner)!;
        if ("definition" in event) {
          const definition = event.definition;
          if (definition.qualifiedName.startsWith("CORE::GLOBAL::")) overrides.add(definition.qualifiedName.slice("CORE::GLOBAL::".length));
          if (definition.hasBody && !definition.conditional && facts.definitions.filter(other => other.qualifiedName === definition.qualifiedName && other.hasBody).length === 1) slots.set(definition.qualifiedName, definition.nodeId);
          else slots.delete(definition.qualifiedName);
        } else if ("alias" in event) {
          const mutation = event.alias, ref = mutation.aliasReference;
          const target = mutation.replacementNodeId ?? (ref && !ref.bindingId && ref.name.kind === "known"
            ? slots.get(ref.name.value.includes("::") ? ref.name.value : `${ref.packageName}::${ref.name.value}`) : undefined);
          invalidate(mutation);
          if (target && !mutation.conditional && mutation.names.kind === "known") for (const name of mutation.names.value) slots.set(name, target);
        } else if ("mutation" in event) invalidate(event.mutation);
        else if ("call" in event) {
          if (opaqueCalls(owner, event.call, opaqueBuiltins, overrides)) opaque();
          else for (const effect of effects().callEffects(owner, event.call)) invalidate(effect);
        } else if ("load" in event) {
          const load = event.load, target = environment.loads.get(load.id);
          if (!target || load.conditional || load.operation === "do") { opaque(); continue; }
          if (load.operation === "require" || load.arguments.kind === "empty") continue;
          if ([...environment.unknownImportLoads?.values() ?? []].some(loads => loads.includes(load.id))) { opaque(); continue; }
          const operation = load.operation === "no" ? "unimport" : "import";
          if (load.target.kind === "known") {
            const call: PerlCall = { ...load, form: "qualified", name: { kind: "known", value: `${load.target.value}::${operation}` } };
            if (effects().importScopes(target.file, load.target.value, operation).length && opaqueCalls(target.file, call, opaqueBuiltins, overrides)) opaque();
            for (const effect of effects().importEffects(target.file, load.target.value, operation)) invalidate(effect);
          }
          for (const bindings of environment.imports.values()) for (const binding of bindings) if (binding.loadId === load.id) {
            const source = slots.get(`${binding.providerPackage}::${binding.exportedName}`);
            const destination = `${binding.packageName}::${binding.name}`;
            if (source) slots.set(destination, source); else slots.delete(destination);
          }
        }
      }
      contexts.set(site, slots);
    }
    return slots?.get(name) ?? null;
  };
}
