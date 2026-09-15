/** Bounded Moo/Moose syntax readers and repository-verified source surfaces. */
import type { Node } from "web-tree-sitter";
import type { RawEdge } from "./extract.js";
import type { NodeV1 } from "./types.js";
import type { PerlDiagnostic, PerlFileFacts, PerlFramework, PerlKnown, PerlModuleEnvironment } from "./perl-types.js";
import { expressionItems, known, literalList, literalString, PERL_NAME, unknown } from "./perl-syntax.js";
import { perlFileExecution } from "./perl-context.js";

export const PERL_FRAMEWORK_NAMES = new Set<PerlFramework["framework"]>(["Moo", "Moose", "Moo::Role", "Moose::Role"]);
export const PERL_FRAMEWORK_DECLARATIONS = new Set<PerlFramework["declaration"]>(["extends", "with", "has", "before", "after", "around"]);
export interface PerlFrameworkSyntax {
  names: PerlKnown<string[]>;
  options: PerlFramework["options"];
  callbacks: { node: Node; label: string }[];
}

export function readPerlFrameworkDeclaration(declaration: PerlFramework["declaration"], args: Node | null): PerlFrameworkSyntax {
  const items = args ? expressionItems(args) : [];
  const result: PerlFrameworkSyntax = { names: unknown("nonliteral framework declaration"), options: [], callbacks: [] };
  if (declaration === "extends" || declaration === "with") {
    const list = literalList(args);
    result.names = list.kind === "known" && list.value.every((name) => PERL_NAME.test(name)) ? list : unknown("computed class/role list or composition options");
    return result;
  }
  if (declaration === "has") {
    const names = literalList(items[0] ?? null);
    result.names = names.kind === "known" && names.value.length && names.value.every((name) => /^\+?[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) ? names : unknown("computed attribute name");
    if (items.length % 2 !== 1) result.options.push({ name: "?", value: unknown("computed attribute options") });
    for (let i = 1; i + 1 < items.length; i += 2) {
      const key = literalString(items[i]);
      const node = items[i + 1];
      let value: PerlKnown<string | number | boolean | null>;
      const text = literalString(node);
      if (text !== null) value = known(text);
      else if (node.type === "number" && /^\d+(?:\.\d+)?$/.test(node.text)) value = known(Number(node.text));
      else if (node.type === "undef_expression") value = known(null);
      else value = unknown(node.type === "anonymous_subroutine_expression" ? "source callback" : "computed attribute option");
      result.options.push({ name: key ?? "?", value });
      if (node.type === "anonymous_subroutine_expression") result.callbacks.push({ node, label: `has(${names.kind === "known" ? names.value.join(",") : "?"}).${key ?? "callback"}` });
    }
    return result;
  }
  const callback = items.at(-1);
  const names: string[] = [];
  let valid = !!callback && callback.type === "anonymous_subroutine_expression";
  for (const item of items.slice(0, -1)) {
    const list = literalList(item);
    if (list.kind === "unknown") valid = false;
    else names.push(...list.value);
  }
  result.names = valid && names.length && names.every((name) => PERL_NAME.test(name)) ? known(names) : unknown("computed modifier target or callback");
  if (callback?.type === "anonymous_subroutine_expression") result.callbacks.push({ node: callback, label: `${declaration}(${valid ? names.join(",") : "?"})` });
  return result;
}

/** The worker retains drafts in JSON facts. Only this pass can rule out an
 * in-repository custom importer or ambiguous framework module lookup. */
export function materializePerlFrameworks(input: ReadonlyMap<string, PerlFileFacts>, environment: PerlModuleEnvironment): { files: ReadonlyMap<string, PerlFileFacts>; nodes: NodeV1[]; rawEdges: RawEdge[]; diagnostics: PerlDiagnostic[] } {
  const files = new Map(input), nodes: NodeV1[] = [], rawEdges: RawEdge[] = [], diagnostics: PerlDiagnostic[] = [];
  for (const [file, raw] of input) {
    if (!raw.frameworks.length) continue;
    const facts = structuredClone(raw);
    files.set(file, facts);
    facts.frameworks = [];
    const report = (fact: PerlFramework, code: string, message: string) => diagnostics.push({ file, code, message, range: fact.range, severity: "warning" });
    for (const fact of raw.frameworks) {
      const load = raw.loads.find((load) => load.id === fact.importLoadId);
      const verified = load && load.operation === "use" && load.arguments.kind === "default" && !environment.loads.has(load.id)
        && !environment.unresolved.some((d) => d.file === file && d.range?.start === load.range.start)
        && ![...input.values()].some((f) => f.definitions.some((d) => d.packageName === fact.framework && d.name === "import"));
      if (!verified) { report(fact, "PERL_FRAMEWORK_IDENTITY_UNKNOWN", `Cannot establish the standard ${fact.framework} importer`); continue; }
      if (fact.declaration === "import") {
        facts.frameworks.push(structuredClone(fact));
        if (fact.framework.endsWith("::Role")) {
          for (const region of facts.packages) if (region.name === fact.packageName) region.kind = "role";
        } else facts.mutations.push({ ...fact, mechanism: "framework", frameworkEffect: "generated", names: known([`${fact.packageName}::new`, `${fact.packageName}::meta`]) });
        continue;
      }
      const conflict = raw.definitions.some((d) => d.packageName === fact.packageName && d.name === fact.declaration && d.kind === "package-sub");
      if (conflict) { report(fact, "PERL_FRAMEWORK_BINDING_CONFLICT", `A local ${fact.declaration} sub conflicts with the framework declaration`); continue; }
      facts.frameworks.push(structuredClone(fact));
      facts.calls = facts.calls.filter((call) => !(call.sourceNode === fact.sourceNode && call.range.start === fact.range.start && call.range.end === fact.range.end));
      if (fact.names.kind === "unknown") report(fact, "PERL_FRAMEWORK_DECLARATION_UNKNOWN", fact.names.reason);
      const deferred = fact.conditional || (fact.phase !== "compile" && fact.phase !== "BEGIN" && !perlFileExecution(facts, fact.scopeId));
      if (deferred) report(fact, "PERL_FRAMEWORK_EXECUTION_UNKNOWN", "Framework declaration has conditional or deferred execution");
      const parent = fact.packageNode ?? fact.sourceNode;
      for (const draft of fact.attributes ?? []) {
        if (deferred) continue;
        const node = structuredClone(draft); nodes.push(node);
        rawEdges.push({ file, source: parent, targetId: node.id, relation: "contains" });
      }
      for (const draft of fact.callbacks ?? []) {
        const node = structuredClone(draft.node); nodes.push(node);
        rawEdges.push({ file, source: draft.parentNode, targetId: node.id, relation: "contains" });
        facts.definitions.push({ nodeId: node.id, name: node.name, qualifiedName: node.qualified_name!, packageName: fact.packageName, packageNode: fact.packageNode ?? null, scopeId: fact.scopeId, kind: "callback", range: draft.range, declarations: [draft.range], hasBody: true, conditional: fact.conditional });
        const scopes = new Set([draft.scopeId]);
        for (const scope of facts.scopes) if (scope.parent && scopes.has(scope.parent)) scopes.add(scope.id);
        for (const site of [...facts.calls, ...facts.references, ...facts.loads, ...facts.includeEffects]) if (site.sourceNode === draft.ownerNode && scopes.has(site.scopeId)) site.sourceNode = node.id;
        for (const scope of facts.scopes) if (scope.ownerNode === draft.ownerNode && scopes.has(scope.id)) scope.ownerNode = node.id;
      }
      if (fact.declaration === "extends") {
        facts.inheritance.push({ ...fact, parents: fact.names, operation: "replace", mechanism: "framework", noRequire: false, mro: "dfs", unknownMutation: deferred || fact.names.kind === "unknown", adapterLoadId: fact.importLoadId });
      } else if (fact.declaration === "with") {
        if (fact.names.kind === "known") for (const name of fact.names.value) facts.references.push({ ...fact, sourceNode: parent, form: "role", name: known(name) });
      } else if (["before", "after", "around"].includes(fact.declaration)) {
        if (fact.names.kind === "known") for (const name of fact.names.value) facts.references.push({ ...fact, sourceNode: parent, form: "modifier", name: known(name) });
        facts.mutations.push({ ...fact, mechanism: "framework", frameworkEffect: "modifier", names: fact.names.kind === "known" ? known(fact.names.value.map((name) => `${fact.packageName}::${name}`)) : fact.names });
      } else if (fact.declaration === "has") {
        const names = fact.names.kind === "known" ? fact.names.value.map((name) => name.replace(/^\+/, "")) : [];
        const attributes = [...names];
        let dynamic = fact.names.kind === "unknown";
        for (const option of fact.options) {
          if (option.value.kind === "unknown" && option.value.reason !== "source callback" || ["handles", "traits", "metaclass"].includes(option.name)) {
            dynamic = true; report(fact, "PERL_FRAMEWORK_OPTION_UNSUPPORTED", `Attribute option ${option.name} has unmodeled method-generation behavior`);
          }
          if (["reader", "writer", "accessor", "predicate", "clearer"].includes(option.name) && option.value.kind === "known" && typeof option.value.value === "string") names.push(option.value.value);
          if (option.value.kind === "known" && option.value.value) {
            if (option.name === "is" && option.value.value === "rwp") names.push(...attributes.map((name) => `_set_${name}`));
            if (option.name === "lazy_build" || option.name === "predicate" && typeof option.value.value !== "string") names.push(...attributes.map((name) => `has_${name}`));
            if (option.name === "lazy_build" || option.name === "clearer" && typeof option.value.value !== "string") names.push(...attributes.map((name) => `clear_${name}`));
          }
        }
        facts.mutations.push({ ...fact, mechanism: "framework", frameworkEffect: "generated", names: dynamic ? unknown("dynamic generated attribute methods") : known(names.map((name) => `${fact.packageName}::${name}`)) });
      }
    }
  }
  return { files, nodes, rawEdges, diagnostics };
}
