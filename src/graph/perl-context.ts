/** Execution boundaries are independent of graph ownership: an unbound
 * anonymous sub has a scope even when it deliberately has no public node. */
import type { PerlFileFacts } from "./perl-types.js";

const executionScopes = new WeakMap<PerlFileFacts, Map<string, string>>();

export function perlExecutionScope(facts: PerlFileFacts, scopeId: string): string {
  let index = executionScopes.get(facts);
  if (!index) {
    index = new Map();
    for (const scope of facts.scopes) {
      const inherited = scope.parent && index.get(scope.parent);
      index.set(scope.id, inherited && (scope.kind === "block" || scope.kind === "class") ? inherited : scope.id);
    }
    executionScopes.set(facts, index);
  }
  return index.get(scopeId) ?? scopeId;
}

export function perlFileExecution(facts: PerlFileFacts, scopeId: string): boolean {
  return perlExecutionScope(facts, scopeId) === facts.scopes[0]?.id;
}
