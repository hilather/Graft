/** Source-backed Perl definitions and file-local semantic intents. */
import { posix } from "node:path";
import type { Node } from "web-tree-sitter";
import { contentHash } from "../util/id.js";
import type { Kind, NodeV1 } from "./types.js";
import type { PerlBinding, PerlContext, PerlDefinition, PerlDiagnostic, PerlExport, PerlExtractResult, PerlFileFacts, PerlInheritance, PerlKnown, PerlLoad, PerlPackageRegion, PerlPhase, PerlRange, PerlReceiver, PerlReference, PerlScope } from "./perl-types.js";
import { PERL_FACTS_VERSION } from "./perl-types.js";
import { PERL_FRAMEWORK_DECLARATIONS, PERL_FRAMEWORK_NAMES, readPerlFrameworkDeclaration } from "./perl-frameworks.js";
import { perlFileExecution } from "./perl-context.js";
import { constantNames, descendants, expressionItems, hasEmbeddedCode, importArguments, inlineConstantNames, known, literalList, literalString, OPAQUE_PERL, packageNameOf, parentArguments, PERL_LIST_BUILTINS, PERL_NAME, unknown, variableName } from "./perl-syntax.js";

export function emptyPerlFacts(file: string): PerlFileFacts {
  return { language: "perl", version: PERL_FACTS_VERSION, file, packages: [], definitions: [], scopes: [], bindings: [], loads: [], includeEffects: [], mutations: [], exports: [], calls: [], references: [], inheritance: [], frameworks: [], diagnostics: [] };
}

export function perlFileResult(file: string, source: string, diagnostics: PerlDiagnostic[] = [], status: PerlExtractResult["status"] = "ok", cacheable = true): PerlExtractResult {
  const languageData = emptyPerlFacts(file);
  languageData.diagnostics = diagnostics;
  const lines = source.split("\n").length;
  return {
    nodes: [{ id: file, kind: "file", name: posix.basename(file), path: file, span: `L1-L${lines}`, signature: null, exported: false, origin: "ast", language: "perl", body_hash: contentHash(source), chars: Buffer.byteLength(source), summary_state: "pending", summary: null, crux: null }],
    rawEdges: [], languageData, status, cacheable,
  };
}

export function perlRange(node: Node): PerlRange {
  return { start: node.startIndex, end: node.endIndex, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

export function extractPerlTree(file: string, source: string, root: Node): PerlExtractResult {
  return new PerlExtractor(file, source).extract(root);
}

interface WalkContext {
  scope: PerlScope;
  packageName: string;
  packageNode: string | null;
  owner: string;
  phase: PerlPhase;
  conditional: boolean;
  contextKnown: boolean;
  className?: string;
}

interface DraftDefinition { node: NodeV1; fact: PerlDefinition }
const PRAGMAS = new Set(["strict", "warnings", "feature", "utf8", "bytes", "integer", "lib", "mro", "constant", "subs", "vars", "re", "experimental", "overload", "overloading", "encoding", "open", "locale", "bigint", "bignum", "bigrat", "autodie", "if", "less", "sigtrap", "attributes", "version"]);
const CONDITIONAL = new Set(["conditional_statement", "loop_statement", "for_statement", "cstyle_for_statement", "foreach_statement", "while_statement", "until_statement", "conditional_expression", "postfix_conditional_expression", "postfix_loop_expression"]);

class PerlExtractor {
  private readonly result: PerlExtractResult;
  private readonly facts: PerlFileFacts;
  private readonly minted = new Set<string>();
  private readonly drafts: DraftDefinition[] = [];
  private readonly scopes = new Map<string, PerlScope>();
  private readonly bindingsByScopeAndName = new Map<string, Map<string, PerlBinding[]>>();
  private readonly receiverScopes = new Set<string>();
  private readonly callbackScopes = new Set<string>();
  private readonly stringInitializers = new Map<string, { value: string; context: PerlContext }>();
  private readonly stringEvals: { node: Node; ctx: WalkContext }[] = [];
  private readonly computedParents: { fact: PerlInheritance; node: Node; scalar: Node; ctx: WalkContext }[] = [];
  private readonly exporter = new Map<string, PerlExport["exporter"]>();
  private opaqueRecoveryStart = Infinity;
  private hasParseErrors = false;

  constructor(private readonly file: string, private readonly source: string) {
    this.result = perlFileResult(file, source);
    this.facts = this.result.languageData;
    this.minted.add(file);
  }

  extract(root: Node): PerlExtractResult {
    // hasError includes missing descendants. Valid files need no separate walk
    // of every punctuation node before the semantic traversal.
    this.hasParseErrors = root.hasError;
    const pending = this.hasParseErrors ? [root] : [];
    if (pending.length) this.facts.initializationOrderUnknown = true;
    while (pending.length) {
      const error = pending.pop()!;
      if (error.type === "ERROR" || error.isMissing) {
        this.diagnostic("PERL_PARSE_ERROR", error.isMissing ? `Missing ${error.type}` : "Unrecognized or incomplete Perl syntax", error);
        if (error.type === "ERROR") {
          // The recovery grammar can resume with a plausible declaration after
          // a broken quote. That text may still be literal data. Ignore intact
          // CST literals inside the error before looking for damaged openers.
          let damaged = error.text;
          for (const literal of descendants(error, (n) => OPAQUE_PERL.has(n.type) && !n.hasError)) damaged = damaged.replace(literal.text, " ");
          if (/[\x22'`]|<<|(?:^|[\s=])(?:qq|qr|qx|q|m|s|tr|y)\s*[^\w\s]/.test(damaged)) {
            this.opaqueRecoveryStart = Math.min(this.opaqueRecoveryStart, error.startIndex);
            this.diagnostic("PERL_OPAQUE_RECOVERY", "Unterminated quote or heredoc can contaminate the remaining file; that tail is not analyzed", error);
          }
        }
      }
      pending.push(...[...error.children].reverse());
    }
    const scope = this.scope(root, null, "file", this.file);
    this.sequence(root.namedChildren, { scope, packageName: "main", packageNode: null, owner: this.file, phase: "runtime", conditional: false, contextKnown: true });
    this.finishStringEvals(root);
    this.mergeDeclarations();
    this.finishBindings();
    this.finishExports();
    this.result.status = this.facts.diagnostics.length ? "partial" : "ok";
    return this.result;
  }

  private diagnostic(code: string, message: string, node?: Node): void {
    // Keep codes visible even when a file has many repeated dynamic sites.
    if (this.facts.diagnostics.filter((d) => d.code === code).length >= 8) return;
    this.facts.diagnostics.push({ code, file: this.file, severity: "warning", message, ...(node ? { range: perlRange(node) } : {}) });
  }

  private mint(name: string): string {
    const base = `${this.file}#${name}`;
    let id = base, ordinal = 2;
    while (this.minted.has(id)) id = `${base}~${ordinal++}`;
    this.minted.add(id);
    return id;
  }

  private scope(node: Node, parent: PerlScope | null, kind: PerlScope["kind"], owner: string): PerlScope {
    const scope: PerlScope = { id: `${this.file}:scope${this.scopes.size}`, parent: parent?.id ?? null, kind, ownerNode: owner, range: perlRange(node), contextKnown: true };
    this.scopes.set(scope.id, scope);
    this.facts.scopes.push(scope);
    return scope;
  }

  private context(node: Node, ctx: WalkContext): PerlContext {
    return { sourceNode: ctx.owner, packageName: ctx.packageName, scopeId: ctx.scope.id, range: perlRange(node), phase: ctx.phase, conditional: ctx.conditional };
  }

  private symbol(name: string, qualified: string, idName: string, kind: Kind, node: Node, headerEnd: number, parent: string, emit = true): NodeV1 {
    const range = perlRange(node);
    const text = this.source.slice(range.start, range.end);
    const symbol: NodeV1 = { id: this.mint(idName), name, qualified_name: qualified, kind, path: this.file, span: `L${range.startLine}-L${range.endLine}`, signature: this.source.slice(range.start, headerEnd).trim().replace(/\s+/g, " "), exported: false, language: "perl", origin: "ast", body_hash: contentHash(text), body_text: text.replace(/\s+/g, " ").slice(0, 5000), summary_state: "pending", summary: null, crux: null };
    if (emit) {
      this.result.nodes.push(symbol);
      this.result.rawEdges.push({ source: parent, relation: "contains", targetId: symbol.id, file: this.file });
    }
    return symbol;
  }

  private sequence(nodes: readonly Node[], inherited: WalkContext): void {
    if (!nodes.length) return;
    const ctx = { ...inherited };
    let region: PerlPackageRegion | undefined;
    for (const node of nodes) {
      if (node.startIndex >= this.opaqueRecoveryStart) continue;
      const type = node.type;
      if (type === "package_statement" || type === "class_statement") {
        if (region && !node.namedChildren.some((n) => n.type === "block")) { region.range.end = node.startIndex; region.range.endLine = node.startPosition.row + 1; }
        const next = this.package(node, ctx);
        if (next) region = next;
      } else this.walk(node, ctx, type);
    }
  }

  private package(node: Node, ctx: WalkContext): PerlPackageRegion | undefined {
    const name = node.childForFieldName("name");
    const block = node.namedChildren.find((n) => n.type === "block");
    if (!name || name.hasError || !PERL_NAME.test(name.text) || node.children.some((n) => n.id !== block?.id && n.hasError)) {
      ctx.contextKnown = false;
      ctx.scope.contextKnown = false;
      this.diagnostic("PERL_PACKAGE_CONTEXT_UNKNOWN", "Package declaration is incomplete or unsupported", node);
      return;
    }
    const isClass = node.type === "class_statement";
    const parent = ctx.owner;
    const symbol = this.symbol(name.text, name.text, name.text, isClass ? "class" : "module", node, block?.startIndex ?? node.endIndex, parent);
    const region: PerlPackageRegion = { name: name.text, nodeId: symbol.id, scopeId: ctx.scope.id, kind: isClass ? "class" : "package", range: { ...perlRange(node), end: block ? node.endIndex : ctx.scope.range.end, endLine: block ? node.endPosition.row + 1 : ctx.scope.range.endLine }, declaration: perlRange(node) };
    this.facts.packages.push(region);
    const updated = { ...ctx, packageName: name.text, packageNode: symbol.id, contextKnown: true, ...(isClass ? { className: name.text } : { className: undefined }) };
    if (isClass) {
      const attributes = node.childForFieldName("attributes");
      for (const attr of attributes?.namedChildren ?? []) {
        if (attr.childForFieldName("name")?.text === "isa") {
          const parent = attr.childForFieldName("value")?.text;
          const parents = parent && PERL_NAME.test(parent) ? known([parent]) : unknown<string[]>("nonliteral class parent");
          const loadIds = parents.kind === "known" ? this.parentLoads(node, updated, parents.value.filter((parent) => !this.facts.packages.some((p) => p.name === parent && p.kind === "class" && p.declaration.end <= node.startIndex)), "class") : [];
          this.facts.inheritance.push({ ...this.context(node, updated), phase: "compile", parents, loadIds, operation: "replace", mechanism: "class", noRequire: false, mro: "dfs", unknownMutation: parents.kind === "unknown" });
        }
      }
    }
    if (block) {
      updated.scope = this.scope(block, ctx.scope, isClass ? "class" : "block", ctx.owner);
      region.scopeId = updated.scope.id;
      this.sequence(block.namedChildren, updated);
      return;
    }
    Object.assign(ctx, updated);
    return region;
  }

  private walk(node: Node, ctx: WalkContext, type = node.type): void {
    if (node.startIndex >= this.opaqueRecoveryStart) return;
    // Reuse sequence's type read. An error-free tree cannot contain a missing
    // node, so it also needs no per-node WASM missing-node query.
    if (type === "ERROR" || (this.hasParseErrors && node.isMissing)) {
      this.facts.initializationOrderUnknown = true;
      // A broken package header can otherwise lend the previous namespace to
      // following declarations. A complete subsequent package restores it.
      if (/\b(?:package|class)\b/.test(node.text)) { ctx.contextKnown = false; ctx.scope.contextKnown = false; }
      return;
    }
    if (OPAQUE_PERL.has(type) || type === "__DATA__" || type === "__END__") {
      if (hasEmbeddedCode(node)) this.diagnostic("PERL_EMBEDDED_CODE_UNSUPPORTED", "Executable interpolation or regex code is not traversed", node);
      return;
    }
    if (type === "subroutine_declaration_statement" || type === "method_declaration_statement") { this.declaration(node, ctx); return; }
    if (type === "anonymous_subroutine_expression" || type === "anonymous_method_expression") { this.anonymous(node, ctx); return; }
    if (type === "phaser_statement" || type === "class_phaser_statement") { this.phaser(node, ctx); return; }
    if (type === "block" || type === "block_statement") {
      this.sequence(node.namedChildren, { ...ctx, scope: this.scope(node, ctx.scope, "block", ctx.owner) });
      return;
    }
    if (!ctx.contextKnown) {
      // Still descend through blocks so a fresh, valid package can recover.
      this.sequence(node.namedChildren, ctx);
      return;
    }
    if (type === "statement_label" || type === "label" || type === "loopex_expression") {
      // Nonlocal control in a deferred helper can also revisit a caller's
      // earlier statement. Retain file-wide uncertainty until control targets
      // have an explicit scope-level representation.
      this.facts.initializationOrderUnknown = true;
    }
    if (type === "assignment_expression") { this.assignment(node, ctx); return; }
    if (type === "variable_declaration") { this.variable(node, ctx); return; }
    if (["binary_expression", "lowprec_logical_expression"].includes(type)) {
      const left = node.childForFieldName("left"), right = node.childForFieldName("right");
      const operator = left && right ? this.source.slice(left.endIndex, right.startIndex).trim() : "";
      if (left && right && ["&&", "||", "//", "and", "or"].includes(operator)) { this.walk(left, ctx); this.walk(right, { ...ctx, conditional: true }); return; }
    }
    if (type === "func1op_call_expression") {
      const name = node.children[0]?.text;
      if (name && PERL_NAME.test(name)) this.facts.calls.push({ ...this.context(node, ctx), form: "bare", name: known(name), syntax: "builtin" });
      if (name === "chdir") this.facts.includeEffects.push({ ...this.context(node, ctx), operation: "unknown", directories: unknown("process working directory may change"), affectsCwd: true });
    }
    if (["localization_expression", "increment_expression", "decrement_expression"].includes(type) || (type === "func1op_call_expression" && ["delete", "pop", "shift", "undef"].includes(node.children[0]?.text ?? ""))) this.unknownTableMutation(node, ctx);
    if (["use_statement", "use_version_statement", "require_expression", "require_version_expression"].includes(type)) { this.load(node, ctx); return; }
    if (type === "eval_expression") {
      const filename = node.namedChildren.find((n) => n.type === "filename");
      if (filename) { this.load(node, ctx, filename.firstNamedChild); return; }
      if (!node.namedChildren.some((n) => n.type === "block")) {
        // RT-style optional overlays use eval as an exception boundary around
        // one literal require. Recognize that bounded syntax without executing
        // Perl or treating interpolated/arbitrary eval bodies as source.
        const text = node.namedChildren.length === 1 ? literalString(node.firstNamedChild) : null;
        const required = text?.match(/^\s*require\s+([A-Za-z_]\w*(?:::\w+)*)\s*;?\s*$/)?.[1];
        if (required) {
          this.facts.loads.push({ ...this.context(node, ctx), id: `${this.file}:load${this.facts.loads.length}`,
            operation: "require", targetKind: "module", target: known(required), arguments: { kind: "empty" }, trapped: true });
          return;
        }
        // Finish after all lexical declarations and writes are visible. A later
        // compiled closure can change a captured scalar before this eval runs.
        this.stringEvals.push({ node, ctx: { ...ctx } });
        return;
      }
    }
    if (type === "refgen_expression") {
      const ref = node.firstNamedChild;
      if (ref?.type === "function") {
        const name = ref.text.replace(/^&/, "");
        this.facts.references.push({ ...this.context(node, ctx), form: PERL_NAME.test(name) ? "named-coderef" : "dynamic", name: PERL_NAME.test(name) ? known(name) : unknown("dynamic coderef") });
        return;
      }
    }
    if (["function_call_expression", "ambiguous_function_call_expression", "method_call_expression", "coderef_call_expression"].includes(type)) { this.call(node, ctx, type); return; }
    if (type === "autoquoted_bareword") { this.unaryConstant(node, ctx); return; }
    if (type === "bareword" && PERL_NAME.test(node.text)) {
      this.facts.calls.push({ ...this.context(node, ctx), form: node.text.includes("::") ? "qualified" : "bare", name: known(node.text), syntax: "bareword" });
      return;
    }
    const nested = CONDITIONAL.has(type) ? { ...ctx, conditional: true } : ctx;
    this.sequence(node.namedChildren, nested);
  }

  private declaration(node: Node, ctx: WalkContext): void {
    const name = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!ctx.contextKnown || !name || !PERL_NAME.test(name.text) || node.children.some((n) => n.id !== body?.id && n.hasError)) {
      this.diagnostic("PERL_DEFINITION_CONTEXT_UNKNOWN", "Definition header or package context is uncertain", node);
      return;
    }
    const lexicalToken = node.childForFieldName("lexical")?.text;
    const isOur = node.children[0]?.type === "our";
    const prior = !isOur && !lexicalToken && !name.text.includes("::") ? this.binding(name.text, ctx.scope.id, node.startIndex) : undefined;
    const lexical = !!lexicalToken || prior?.kind === "lexical-sub";
    if (lexical && name.text.includes("::")) { this.diagnostic("PERL_LEXICAL_NAME_INVALID", "Lexical subs cannot have package-qualified names", node); return; }
    const identity = packageNameOf(name.text, ctx.packageName);
    const ownerScope = prior?.kind === "lexical-sub" ? this.scopes.get(prior.scopeId)! : ctx.scope;
    const idName = identity.qualifiedName + (lexical ? `@${ownerScope.id.slice(ownerScope.id.lastIndexOf(":") + 1)}` : "");
    const kind = node.type === "method_declaration_statement" ? "method" : "function";
    const parent = lexical ? ctx.owner : identity.packageName === ctx.packageName ? ctx.packageNode ?? this.file : this.file;
    const symbol = this.symbol(identity.name, identity.qualifiedName, idName, kind, node, body?.startIndex ?? node.endIndex, parent);
    if (kind === "method") symbol.owner = identity.packageName;
    const fact: PerlDefinition = { nodeId: symbol.id, ...identity, packageNode: identity.packageName === ctx.packageName ? ctx.packageNode : null, scopeId: ownerScope.id, kind: lexical ? "lexical-sub" : kind === "method" ? "method" : "package-sub", range: perlRange(node), declarations: [perlRange(node)], hasBody: !!body, conditional: ctx.conditional };
    this.facts.definitions.push(fact);
    this.drafts.push({ node: symbol, fact });
    if (lexicalToken || isOur) {
      this.registerBinding({ id: `${this.file}:binding${this.facts.bindings.length}`, scopeId: ctx.scope.id, packageName: identity.packageName, name: identity.name, kind: isOur ? "our-alias" : "lexical-sub", target: known({ nodeId: symbol.id }), range: perlRange(node), visibleFrom: node.endIndex, visibleUntil: ctx.scope.range.end, invalidations: [] });
    }
    if (body) {
      const scope = this.scope(body, ctx.scope, "sub", symbol.id);
      const child = { ...ctx, scope, owner: symbol.id, phase: "runtime" as const };
      // Explicitly qualified declarations change the symbol identity, not the
      // lexical package in which the body is compiled.
      this.signatureBindings(node, child);
      if (kind === "method") this.declaredSelf(node, child);
      this.sequence(body.namedChildren, child);
    }
  }

  private anonymous(node: Node, ctx: WalkContext, bindingName?: string): string | undefined {
    const body = node.childForFieldName("body");
    if (!body || node.children.some((n) => n.id !== body.id && n.hasError)) return;
    let owner = ctx.owner;
    let id: string | undefined;
    if (bindingName) {
      const qualified = `${ctx.packageName}::${bindingName}`;
      const symbol = this.symbol(bindingName, qualified, `${qualified}@${ctx.scope.id.slice(ctx.scope.id.lastIndexOf(":") + 1)}`, "function", node, body.startIndex, ctx.owner);
      id = owner = symbol.id;
      const fact: PerlDefinition = { nodeId: id, name: bindingName, qualifiedName: qualified, packageName: ctx.packageName, packageNode: ctx.packageNode, scopeId: ctx.scope.id, kind: "callback", range: perlRange(node), declarations: [perlRange(node)], hasBody: true, conditional: ctx.conditional };
      this.facts.definitions.push(fact);
      this.drafts.push({ node: symbol, fact });
    }
    const child = { ...ctx, owner, scope: this.scope(body, ctx.scope, "callback", owner), phase: "runtime" as const };
    this.signatureBindings(node, child);
    if (node.type === "anonymous_method_expression") this.declaredSelf(node, child);
    this.sequence(body.namedChildren, child);
    return id;
  }

  private phaser(node: Node, ctx: WalkContext): void {
    const body = node.namedChildren.find((n) => n.type === "block");
    const phase = node.childForFieldName("phase")?.text as PerlPhase | undefined;
    if (!body || !phase || !ctx.contextKnown) return;
    if (!["BEGIN", "UNITCHECK", "CHECK", "INIT", "END", "ADJUST"].includes(phase)) { this.diagnostic("PERL_PHASE_UNSUPPORTED", "This phaser dialect is not part of the supported core surface", node); return; }
    const symbol = this.symbol(phase, `${ctx.packageName}::${phase}`, `${ctx.packageName}::${phase}`, "function", node, body.startIndex, ctx.packageNode ?? ctx.owner);
    const fact: PerlDefinition = { nodeId: symbol.id, name: phase, qualifiedName: `${ctx.packageName}::${phase}`, packageName: ctx.packageName, packageNode: ctx.packageNode, scopeId: ctx.scope.id, kind: "phaser", range: perlRange(node), declarations: [perlRange(node)], hasBody: true, conditional: ctx.conditional };
    this.facts.definitions.push(fact);
    const child = { ...ctx, owner: symbol.id, phase, scope: this.scope(body, ctx.scope, "phaser", symbol.id) };
    this.signatureBindings(node, child);
    if (phase === "ADJUST") this.declaredSelf(node, child);
    this.sequence(body.namedChildren, child);
  }

  private signatureBindings(node: Node, ctx: WalkContext): void {
    const signature = node.namedChildren.find((n) => n.type === "signature");
    for (const variable of signature ? descendants(signature, (n) => n.type === "scalar" || n.type === "array" || n.type === "hash") : []) {
      const name = variableName(variable);
      if (name) this.newBinding(name, variable, ctx, ctx.scope.range.start);
    }
  }

  private declaredSelf(node: Node, ctx: WalkContext): void {
    if (!ctx.className) { this.diagnostic("PERL_CLASS_CONTEXT_UNKNOWN", "Core method/ADJUST syntax has no source-declared class context", node); return; }
    const binding = this.newBinding("$self", node, ctx, ctx.scope.range.start);
    binding.receiver = { kind: "declared-self", packageName: ctx.className };
    this.receiverScopes.add(binding.scopeId);
  }

  private newBinding(name: string, node: Node, ctx: WalkContext, visibleFrom = node.endIndex): PerlBinding {
    const binding: PerlBinding = { id: `${this.file}:binding${this.facts.bindings.length}`, scopeId: ctx.scope.id, packageName: ctx.packageName, name, kind: "lexical-variable", target: unknown("no proven callable value"), range: perlRange(node), visibleFrom, visibleUntil: ctx.scope.range.end, invalidations: [] };
    this.registerBinding(binding);
    return binding;
  }

  private registerBinding(binding: PerlBinding): void {
    this.facts.bindings.push(binding);
    let names = this.bindingsByScopeAndName.get(binding.scopeId);
    if (!names) { names = new Map(); this.bindingsByScopeAndName.set(binding.scopeId, names); }
    const bindings = names.get(binding.name);
    if (bindings) bindings.push(binding);
    else names.set(binding.name, [binding]);
  }

  private hasEscapableBinding(scopeId: string, receiversOnly = false): boolean {
    for (let scope = this.scopes.get(scopeId); scope; scope = scope.parent ? this.scopes.get(scope.parent) : undefined) {
      if (this.receiverScopes.has(scope.id) || !receiversOnly && this.callbackScopes.has(scope.id)) return true;
    }
    return false;
  }

  private variable(node: Node, ctx: WalkContext, definitionNode = node): void {
    const declaration = node.children[0]?.text;
    const vars = descendants(node, (n) => !!variableName(n) && n.type !== "variable_declaration");
    for (const variable of vars) {
      const name = variableName(variable)!;
      if (declaration === "my" || declaration === "state" || declaration === "our") {
        const binding = this.newBinding(name, node, ctx);
        if (declaration === "our") binding.kind = "our-alias";
      }
      if (declaration === "field") {
        const qualified = `${ctx.packageName}::${name}`;
        const symbol = this.symbol(name, qualified, qualified, "variable", definitionNode, definitionNode.endIndex, ctx.packageNode ?? ctx.owner);
        this.facts.definitions.push({ nodeId: symbol.id, name, qualifiedName: qualified, packageName: ctx.packageName, packageNode: ctx.packageNode, scopeId: ctx.scope.id, kind: "field", range: perlRange(definitionNode), declarations: [perlRange(definitionNode)], hasBody: true, conditional: ctx.conditional });
      }
    }
  }

  private assignment(node: Node, ctx: WalkContext): void {
    const left = node.childForFieldName("left"), right = node.childForFieldName("right");
    if (!left || !right) return;
    const name = variableName(left);
    const declaration = left.type === "variable_declaration" ? left.children[0]?.text : undefined;
    // Index/key expressions and lvalue-returning calls execute on an assignment
    // target too. A declaration is registered separately below, exactly once.
    if (!declaration) this.walk(left, ctx);
    if (declaration === "field") {
      this.variable(left, ctx, node);
      const field = this.facts.definitions.at(-1);
      if (field?.kind === "field") {
        const child = { ...ctx, owner: field.nodeId, scope: this.scope(right, ctx.scope, "callback", field.nodeId), phase: "runtime" as const };
        this.declaredSelf(right, child);
        this.walk(right, child);
      }
      return;
    }
    for (const variable of this.hasEscapableBinding(ctx.scope.id, true) ? descendants(right, (n) => n.type === "scalar") : []) {
      const escaped = this.binding(variableName(variable) ?? "", ctx.scope.id, node.startIndex);
      if (escaped?.receiver) escaped.invalidations.push({ at: node.endIndex, reason: "escape" });
    }
    if (name && declaration !== "my" && declaration !== "state") this.tableAssignment(node, ctx, name, right);
    if (!name || /^[%*](?:main::)?INC$/.test(name) || name.endsWith("EXPORT_FAIL")) this.unknownTableMutation(left, ctx);
    if (name && (declaration === "my" || declaration === "state")) {
      const binding = this.newBinding(name, left, ctx, node.endIndex);
      const value = literalString(right);
      if (declaration === "my" && name.startsWith("$") && value !== null
        && this.source.slice(left.endIndex, right.startIndex).trim() === "=") {
        this.stringInitializers.set(binding.id, { value, context: this.context(node, ctx) });
      }
      if (right.type === "anonymous_subroutine_expression") {
        const id = this.anonymous(right, ctx, name);
        if (id) { binding.kind = "lexical-coderef"; binding.target = known({ nodeId: id }); this.callbackScopes.add(binding.scopeId); }
        return;
      }
      const receiver = this.blessReceiver(right, ctx);
      if (receiver) { binding.receiver = receiver; this.receiverScopes.add(binding.scopeId); }
    } else if (name && !declaration) {
      const binding = this.binding(name, ctx.scope.id, node.startIndex);
      if (binding) binding.invalidations.push({ at: node.startIndex, reason: "assignment" });
    } else if (declaration) this.variable(left, ctx);
    if (left.type === "glob") {
      const identity = name ? packageNameOf(name.slice(1), ctx.packageName) : null;
      const ref = right.type === "refgen_expression" ? right.firstNamedChild : null;
      const refName = ref?.type === "function" ? ref.text.replace(/^&/, "") : null;
      const aliasReference: PerlReference | undefined = identity && refName && PERL_NAME.test(refName) && !right.hasError
        && this.source.slice(left.endIndex, right.startIndex).trim() === "="
        ? { ...this.context(right, ctx), form: "named-coderef", name: known(refName) } : undefined;
      if (!aliasReference) this.diagnostic("PERL_SYMBOL_TABLE_MUTATION", "Typeglob assignment does not establish a proven callable alias", node);
      const body = right.type === "anonymous_subroutine_expression" && right.namedChildren.length === 1 ? right.firstNamedChild : null;
      const emptyReplacement = body?.type === "block" && body.namedChildren.length === 0 && !right.hasError
        && this.source.slice(left.endIndex, right.startIndex).trim() === "=";
      this.facts.mutations.push({ ...this.context(node, ctx), names: identity ? known([identity.qualifiedName]) : unknown("computed typeglob"), ...(aliasReference ? { aliasReference } : {}), ...(emptyReplacement ? { emptyReplacement: true as const } : {}) });
      if (aliasReference) { this.facts.references.push(aliasReference); return; }
    }
    this.walk(right, ctx);
  }

  private load(node: Node, ctx: WalkContext, doTarget?: Node | null): void {
    const use = node.type === "use_statement" || node.type === "use_version_statement";
    const version = node.type === "use_version_statement" || node.type === "require_version_expression";
    const module = node.childForFieldName("module");
    const targetNode = doTarget ?? module ?? node.childForFieldName("version") ?? node.firstNamedChild;
    const name = targetNode && (module || version || targetNode.type === "bareword") ? targetNode.text : literalString(targetNode);
    const targetKind: PerlLoad["targetKind"] = version ? "version" : module && name && PRAGMAS.has(name) ? "pragma" : (module || targetNode?.type === "bareword") ? "module" : name !== null ? "file" : "dynamic";
    const args = use && module ? node.namedChildren.find((n) => n.id !== module.id && n.id !== node.childForFieldName("version")?.id) ?? null : null;
    const load: PerlLoad = { ...this.context(node, ctx), id: `${this.file}:load${this.facts.loads.length}`, operation: doTarget ? "do" : use ? node.children[0]?.text === "no" ? "no" : "use" : "require", targetKind, target: name !== null ? known(name) : unknown("computed load target"), arguments: use ? importArguments(args) : { kind: "empty" }, ...(use ? { phase: "compile" as const, conditional: false } : {}) };
    this.facts.loads.push(load);
    if (use && load.operation === "use" && name && PERL_FRAMEWORK_NAMES.has(name as "Moo")) this.facts.frameworks.push({ ...load, framework: name as "Moo", declaration: "import", names: known([name]), options: [], callbackNodes: [], importLoadId: load.id, ...(ctx.packageNode ? { packageNode: ctx.packageNode } : {}) });
    if (use && name === "lib") this.facts.includeEffects.push({ ...this.context(node, ctx), phase: "compile", conditional: false, operation: load.operation === "no" ? "remove" : "prepend", directories: literalList(args) });
    if (targetKind === "dynamic") this.diagnostic("PERL_DYNAMIC_LOAD", "Computed load target remains unresolved", node);
    if (use && load.operation === "use" && name === "Exporter" && load.arguments.kind === "list" && load.arguments.symbols.includes("import")) this.exporter.set(ctx.packageName, "import");
    if (use && load.operation === "use" && (name === "parent" || name === "base")) {
      const { parents: normalized, noRequire } = name === "parent" ? parentArguments(args) : { parents: literalList(args), noRequire: false };
      const loadIds = !noRequire && normalized.kind === "known" ? this.parentLoads(node, ctx, normalized.value, name, load.id) : [];
      this.facts.inheritance.push({ ...this.context(node, ctx), phase: "compile", conditional: false, parents: normalized, loadIds, adapterLoadId: load.id, operation: "append", mechanism: name, noRequire, mro: "dfs", unknownMutation: normalized.kind === "unknown" });
      if (normalized.kind === "known" && normalized.value.includes("Exporter")) this.exporter.set(ctx.packageName, "inheritance");
    }
    if (use && name === "mro" && args) {
      const values = literalList(args);
      const mro = values.kind === "known" && (values.value[0] === "c3" || values.value[0] === "dfs") ? values.value[0] : "unknown";
      this.facts.inheritance.push({ ...this.context(node, ctx), phase: "compile", conditional: false, parents: known([]), operation: "replace", mechanism: "mro", noRequire: true, mro, unknownMutation: mro === "unknown" });
    }
    if (use && name === "constant" && load.operation === "use" && args) this.constant(node, args, ctx);
    if (args && literalList(args).kind === "unknown" && !(name === "parent" && parentArguments(args).parents.kind === "known")) this.walk(args, { ...ctx, phase: "compile", conditional: false });
  }

  private parentLoads(node: Node, ctx: WalkContext, parents: string[], mechanism: "parent" | "base" | "class", viaLoadId?: string): string[] {
    return parents.map((parent) => {
      const id = `${this.file}:load${this.facts.loads.length}`;
      this.facts.loads.push({ ...this.context(node, ctx), id, operation: "require", phase: "compile", conditional: false, targetKind: "module", target: known(parent), arguments: { kind: "empty" }, implicit: mechanism, ...(viaLoadId ? { viaLoadId } : {}) });
      return id;
    });
  }

  private constant(node: Node, args: Node, ctx: WalkContext): void {
    const names = constantNames(args);
    if (names.kind === "unknown") { this.diagnostic("PERL_CONSTANT_UNRESOLVED", names.reason, node); return; }
    const inlined = inlineConstantNames(args);
    for (const name of names.value) {
      const identity = packageNameOf(name, ctx.packageName);
      const symbol = this.symbol(identity.name, identity.qualifiedName, identity.qualifiedName, "constant", node, node.endIndex, ctx.packageNode ?? ctx.owner);
      this.facts.definitions.push({ nodeId: symbol.id, ...identity, packageNode: ctx.packageNode, scopeId: ctx.scope.id, kind: "constant", range: perlRange(node), declarations: [perlRange(node)], hasBody: true, conditional: false, ...(inlined.has(name) ? { inlineConstant: true as const } : {}) });
    }
  }

  private tableAssignment(node: Node, ctx: WalkContext, variable: string, right: Node, append = false, rest: readonly Node[] = []): void {
    if (!variable.includes("::") && this.binding(variable, ctx.scope.id, node.startIndex)?.kind === "lexical-variable") return;
    const identity = packageNameOf(variable.slice(1), ctx.packageName);
    const operator = node.childForFieldName("function")?.text === "unshift" ? "unshift" : node.childForFieldName("operator")?.text ?? "=";
    const lists = [right, ...rest].map(literalList);
    const values = lists.find((list) => list.kind === "unknown") ?? known(lists.flatMap((list) => list.kind === "known" ? list.value : []));
    if (variable === "@INC" || variable === "@main::INC") {
      this.facts.includeEffects.push({ ...this.context(node, ctx), operation: operator === "unshift" ? "prepend" : append ? "append" : operator === "=" ? "replace" : "unknown", directories: values });
      return;
    }
    if (variable[0] === "@" && identity.name === "ISA") {
      const parents = values;
      const fact: PerlInheritance = { ...this.context(node, ctx), packageName: identity.packageName, parents, operation: append ? "append" : "replace", mechanism: "ISA", noRequire: true, mro: "dfs", unknownMutation: parents.kind === "unknown" || operator !== "=" || ctx.conditional || (ctx.phase === "runtime" && !perlFileExecution(this.facts, ctx.scope.id)) };
      this.facts.inheritance.push(fact);
      if (append && operator === "=" && right.type === "scalar" && !rest.length && !ctx.conditional) this.computedParents.push({ fact, node, scalar: right, ctx: { ...ctx } });
      if (parents.kind === "known" && parents.value.includes("Exporter") && !ctx.conditional) this.exporter.set(identity.packageName, "inheritance");
      return;
    }
    if (!((variable[0] === "@" && ["EXPORT", "EXPORT_OK"].includes(identity.name)) || (variable[0] === "%" && identity.name === "EXPORT_TAGS"))) return;
    const base = { packageName: identity.packageName, scopeId: ctx.scope.id, range: perlRange(node), exporter: "unknown" as const, operation: append ? "append" as const : "replace" as const, unknownMutation: ctx.conditional || operator !== "=" || (ctx.phase === "runtime" && ctx.owner !== this.file) };
    if (identity.name === "EXPORT_TAGS") {
      const items = right.type === "stub_expression" ? [] : [right, ...rest].flatMap(expressionItems);
      if (items.length % 2 === 0 && items.every((item, i) => i % 2 || literalString(item) !== null)) {
        if (!items.length) this.facts.exports.push({ ...base, kind: "tag", resetTags: true, symbols: known([]) });
        for (let i = 0; i < items.length; i += 2) this.facts.exports.push({ ...base, kind: "tag", ...(i === 0 ? { resetTags: true } : {}), tag: literalString(items[i])!, symbols: literalList(items[i + 1]) });
      } else this.facts.exports.push({ ...base, kind: "tag", symbols: unknown("computed export tags"), unknownMutation: true });
    } else this.facts.exports.push({ ...base, kind: identity.name === "EXPORT" ? "default" : "optional", symbols: values });
  }

  private unknownTableMutation(node: Node, ctx: WalkContext): void {
    const names = new Set<string>();
    for (const variable of descendants(node, (n) => !!variableName(n) || n.type === "array_element_expression" || n.type === "hash_element_expression")) {
      let name = variableName(variable);
      if (!name && variable.type === "array_element_expression") name = variable.childForFieldName("array")?.text.replace(/^\$/, "@") ?? null;
      if (!name && variable.type === "hash_element_expression") name = variable.childForFieldName("hash")?.text.replace(/^\$/, "%") ?? null;
      if (name && (!this.binding(name, ctx.scope.id, node.startIndex) || name.includes("::") || this.binding(name, ctx.scope.id, node.startIndex)?.kind === "our-alias")) names.add(name);
    }
    if ([...names].some((name) => /^[@%*](?:main::)?INC$/.test(name))) {
      this.facts.includeEffects.push({ ...this.context(node, ctx), operation: "unknown", directories: unknown("unmodeled INC mutation or localization"), ...( [...names].some((name) => /^[%*](?:main::)?INC$/.test(name)) ? { affectsLoaded: true } : {}) });
      this.diagnostic("PERL_INCLUDE_PATH_UNKNOWN", "INC mutation or localization is not statically modeled", node);
    }
    for (const name of names) {
      const identity = packageNameOf(name.slice(1), ctx.packageName);
      if (["EXPORT", "EXPORT_OK", "EXPORT_TAGS", "EXPORT_FAIL"].includes(identity.name)) {
        this.facts.exports.push({ packageName: identity.packageName, scopeId: ctx.scope.id, range: perlRange(node), exporter: "unknown", kind: identity.name === "EXPORT" ? "default" : identity.name === "EXPORT_TAGS" ? "tag" : "optional", symbols: unknown("unmodeled export table mutation"), operation: "append", unknownMutation: true });
        this.diagnostic("PERL_EXPORT_TABLE_UNKNOWN", "Partial or dynamic export table mutation is not statically modeled", node);
      } else if (identity.name === "ISA") this.facts.inheritance.push({ ...this.context(node, ctx), packageName: identity.packageName, parents: unknown("partial ISA mutation"), operation: "append", mechanism: "ISA", noRequire: true, mro: "unknown", unknownMutation: true });
    }
  }

  private call(node: Node, ctx: WalkContext, type: string): void {
    const args = node.childForFieldName("arguments");
    if (type === "method_call_expression") {
      const method = node.childForFieldName("method")!;
      const invocant = node.childForFieldName("invocant");
      const name = method.text;
      const receiver = name.startsWith("SUPER::") ? { kind: "super" as const, lexicalPackage: ctx.packageName } : this.receiver(invocant, ctx);
      const isName = PERL_NAME.test(name);
      this.facts.calls.push({ ...this.context(node, ctx), form: isName ? "method" : "dynamic", name: isName ? known(name.replace(/^SUPER::/, "")) : unknown("computed method name"), receiver });
      if (!isName || receiver.kind === "unknown") this.diagnostic("PERL_DYNAMIC_DISPATCH", "Method receiver or name is not statically known", node);
      if (invocant && !["bareword", "scalar", "string_literal", "interpolated_string_literal"].includes(invocant.type)) this.walk(invocant, ctx);
    } else {
      const functionNode = node.childForFieldName("function");
      const functionName = functionNode?.text.replace(/^&/, "");
      const ref = type === "coderef_call_expression" ? node.namedChildren.find((n) => n.id !== args?.id) : null;
      const variable = ref ? variableName(ref) : functionName?.startsWith("$") ? functionName : null;
      if (type === "coderef_call_expression" || variable) {
        const binding = variable ? this.binding(variable, ctx.scope.id, node.startIndex) : undefined;
        this.facts.calls.push({ ...this.context(node, ctx), form: "coderef", name: variable ? known(variable) : unknown("computed coderef"), ...(binding ? { bindingId: binding.id } : {}) });
      } else if (functionName) {
        const isName = PERL_NAME.test(functionName);
        const indirectObject = node.namedChildren.find((n) => n.type === "indirect_object");
        // These operators have a filehandle slot, not an indirect method
        // receiver. Its block is evaluated before the printed argument list.
        const filehandle = indirectObject && !functionNode!.text.startsWith("&") && /^(?:CORE::)?(?:print|printf|say)$/.test(functionName);
        const indirect = indirectObject && !filehandle;
        const subtraction = !indirect && !functionNode!.text.startsWith("&") && type === "ambiguous_function_call_expression" && args ? this.constantSubtraction(args, functionName, node, ctx) : undefined;
        const emptyArguments = !indirect && (!args || (args.type === "parenthesized_expression" && args.namedChildren.every((item) => item.type === "comment")));
        this.facts.calls.push({ ...this.context(node, ctx), form: isName && !indirect ? functionName.includes("::") ? "qualified" : "bare" : "dynamic", name: isName && !indirect ? known(functionName) : unknown("computed or indirect function call"), ...(functionNode?.text.startsWith("&") ? { syntax: "ampersand" as const } : {}), ...(emptyArguments || subtraction ? { emptyArguments: true as const } : {}), ...(subtraction ? { requiresInlineConstant: subtraction, range: perlRange(functionNode!) } : {}) });
        if (filehandle) for (const block of indirectObject.namedChildren) if (block.type === "block") this.walk(block, ctx);
        if (!indirect && args && this.frameworkCall(node, ctx, functionName, args)) return;
        if (functionName === "mro::set_mro") {
          const target = args ? literalString(expressionItems(args)[0]) : null;
          this.facts.inheritance.push({ ...this.context(node, ctx), packageName: target && PERL_NAME.test(target) ? target : ctx.packageName, allPackages: !target || !PERL_NAME.test(target), parents: known([]), operation: "replace", mechanism: "mro", noRequire: true, mro: "unknown", unknownMutation: true });
          this.diagnostic("PERL_MRO_HELPER_UNSUPPORTED", "Runtime MRO helper calls do not establish a static method order", node);
        }
        if ((functionName === "push" || functionName === "unshift") && args) {
          const items = expressionItems(args);
          const variable = variableName(items[0]);
          const override = this.binding(functionName, ctx.scope.id, node.startIndex) || this.facts.loads.some((l) => l.packageName === ctx.packageName && l.operation === "use" && l.range.end < node.startIndex && (l.arguments.kind === "unknown" || (l.arguments.kind === "list" && l.arguments.symbols.includes(functionName))));
          if (override) this.unknownTableMutation(args, ctx);
          else if (variable && items.length >= 2) this.tableAssignment(node, ctx, variable, items[1], functionName === "push", items.slice(2));
        }
        if (["splice", "pop", "shift", "delete", "undef"].includes(functionName) && args) this.unknownTableMutation(args, ctx);
      }
    }
    if (args) {
      // Passing a lexical coderef to unknown code can expose an alias or mutate
      // its value. Later exact calls must not rely on the original assignment.
      for (const variable of this.hasEscapableBinding(ctx.scope.id) ? descendants(args, (n) => n.type === "scalar") : []) {
        const binding = this.binding(variableName(variable) ?? "", ctx.scope.id, variable.startIndex);
        if (binding?.kind === "lexical-coderef" || binding?.receiver) binding.invalidations.push({ at: node.endIndex, reason: "escape" });
      }
      this.walk(args, ctx);
    }
  }

  private constantSubtraction(args: Node, name: string, node: Node, ctx: WalkContext): { name: string; position: number } | undefined {
    if (node.hasError || name.startsWith("CORE::") || PERL_LIST_BUILTINS.has(name) || this.binding(name, ctx.scope.id, node.startIndex)) return;
    const qualified = packageNameOf(name, ctx.packageName).qualifiedName;
    const definitions = this.facts.definitions.filter((definition) => definition.qualifiedName === qualified);
    if (definitions.length !== 1 || !definitions[0].inlineConstant || definitions[0].range.end > node.startIndex) return;
    let prefix: Node | null = args;
    while (prefix?.type === "binary_expression") prefix = prefix.childForFieldName("left");
    if (prefix?.type !== "autoquoted_bareword") return;
    if (!/^-\s*[\p{L}_][\p{L}\p{N}_]*(?:::[\p{L}_][\p{L}\p{N}_]*)*\s*$/u.test(prefix.text)) return;
    // A proven () constant takes no arguments here. The parser cannot know
    // that prototype when choosing between subtraction and an argument list.
    return { name: qualified, position: node.startIndex };
  }

  private unaryConstant(node: Node, ctx: WalkContext): void {
    const text = node.text;
    const match = /^-\s*([\p{L}_][\p{L}\p{N}_]*(?:::[\p{L}_][\p{L}\p{N}_]*)*)\s*$/u.exec(text);
    if (!match || node.hasError || this.binding(match[1], ctx.scope.id, node.startIndex)) return;
    let next = node.nextSibling;
    while (next?.type === "comment") next = next.nextSibling;
    if (next?.type === "=>" || (["hash_element_expression", "slice_expression"].includes(node.parent?.type ?? "") && next?.type === "}")) return;
    const qualified = packageNameOf(match[1], ctx.packageName).qualifiedName;
    const definitions = this.facts.definitions.filter((definition) => definition.qualifiedName === qualified);
    if (definitions.length !== 1 || !definitions[0].inlineConstant || definitions[0].range.end > node.startIndex) return;
    // Unlike an undeclared -option, a compile-time scalar constant is an
    // operand. Forced-quoted keys above and all quoted literal nodes stay inert.
    const offset = text.indexOf(match[1]), start = node.startIndex + offset;
    const line = node.startPosition.row + 1 + (text.slice(0, offset).match(/\n/g)?.length ?? 0);
    this.facts.calls.push({ ...this.context(node, ctx), form: match[1].includes("::") ? "qualified" : "bare", name: known(match[1]), syntax: "bareword", requiresInlineConstant: { name: qualified, position: start }, range: { start, end: start + match[1].length, startLine: line, endLine: line } });
  }

  private frameworkCall(node: Node, ctx: WalkContext, name: string, args: Node): boolean {
    if (!PERL_FRAMEWORK_DECLARATIONS.has(name as "has")) return false;
    const load = this.facts.loads.filter((l) => l.packageName === ctx.packageName && l.range.end < node.startIndex && l.target.kind === "known" && PERL_FRAMEWORK_NAMES.has(l.target.value as "Moo") && (l.operation === "use" || l.operation === "no")).at(-1);
    if (!load || load.operation !== "use" || load.arguments.kind !== "default" || load.target.kind !== "known") return false;
    const parsed = readPerlFrameworkDeclaration(name as "has", args);
    const parent = ctx.packageNode ?? ctx.owner;
    const fact: import("./perl-types.js").PerlFramework = { ...this.context(node, ctx), framework: load.target.value as "Moo", declaration: name as "has", names: parsed.names, options: parsed.options, callbackNodes: [], importLoadId: load.id, ...(ctx.packageNode ? { packageNode: ctx.packageNode } : {}), attributes: [], callbacks: [], loadIds: [] };
    this.facts.frameworks.push(fact);
    if (name === "has" && parsed.names.kind === "known") for (const attribute of parsed.names.value) fact.attributes!.push(this.symbol(attribute, `${ctx.packageName}::${attribute}`, `${ctx.packageName}::has(${attribute})`, "variable", node, node.endIndex, parent, false));
    if ((name === "extends" || name === "with") && parsed.names.kind === "known") for (const target of parsed.names.value) {
      const id = `${this.file}:load${this.facts.loads.length}`;
      fact.loadIds!.push(id);
      this.facts.loads.push({ ...this.context(node, ctx), id, operation: "require", targetKind: "module", target: known(target), arguments: { kind: "empty" }, implicit: "framework", viaLoadId: load.id });
    }
    for (const item of expressionItems(args)) {
      const callback = parsed.callbacks.find((callback) => callback.node.id === item.id);
      if (!callback) { this.walk(item, ctx); continue; }
      const body = item.childForFieldName("body");
      if (!body) continue;
      const scopeSuffix = ctx.scope.id.slice(ctx.scope.id.lastIndexOf(":") + 1);
      const node = this.symbol(callback.label, `${ctx.packageName}::${callback.label}`, `${ctx.packageName}::${callback.label}@${scopeSuffix}`, "function", item, body.startIndex, parent, false);
      const before = this.facts.scopes.length;
      this.anonymous(item, ctx);
      const scope = this.facts.scopes[before];
      if (scope) {
        fact.callbackNodes.push(node.id);
        fact.callbacks!.push({ node, scopeId: scope.id, range: perlRange(item), ownerNode: ctx.owner, parentNode: parent });
      }
    }
    return true;
  }

  private receiver(node: Node | null, ctx: WalkContext): PerlReceiver {
    if (!node) return { kind: "unknown", reason: "missing receiver" };
    if (node.type === "parenthesized_expression" && node.namedChildren.length === 1) return this.receiver(node.firstNamedChild, ctx);
    if (node.type === "func0op_call_expression" && node.childForFieldName("function")?.text === "__PACKAGE__") {
      return { kind: "package", packageName: ctx.packageName };
    }
    const blessed = this.blessReceiver(node, ctx);
    if (blessed) return blessed;
    const name = node.type === "bareword" ? node.text : literalString(node);
    if (name && PERL_NAME.test(name)) return { kind: "package", packageName: name };
    const variable = variableName(node);
    const binding = variable ? this.binding(variable, ctx.scope.id, node.startIndex) : undefined;
    return binding ? { kind: "lexical", bindingId: binding.id } : { kind: "unknown", reason: "no local receiver evidence" };
  }

  private blessReceiver(node: Node, ctx: WalkContext): PerlReceiver | undefined {
    if (node.type === "parenthesized_expression" && node.namedChildren.length === 1) return this.blessReceiver(node.firstNamedChild!, ctx);
    const functionName = node.childForFieldName("function")?.text;
    if (!node.type.endsWith("function_call_expression") || !["bless", "CORE::bless"].includes(functionName ?? "")) return;
    if (functionName === "bless" && (this.binding("bless", ctx.scope.id, node.startIndex) || this.facts.loads.some((l) => l.packageName === ctx.packageName && l.operation === "use" && l.range.end < node.startIndex && (l.arguments.kind === "unknown" || (l.arguments.kind === "list" && l.arguments.symbols.includes("bless")))))) return { kind: "unknown", reason: "bless may be overridden" };
    const args = node.childForFieldName("arguments");
    const items = args ? expressionItems(args) : [];
    const name = items.length === 1 ? ctx.packageName : items.length === 2 ? literalString(items[1]) : null;
    return name && PERL_NAME.test(name) ? { kind: "bless", packageName: name, range: perlRange(node) } : { kind: "unknown", reason: "computed bless package" };
  }

  private binding(name: string, scopeId: string, position: number): PerlBinding | undefined {
    for (let scope = this.scopes.get(scopeId); scope; scope = scope.parent ? this.scopes.get(scope.parent) : undefined) {
      const bindings = this.bindingsByScopeAndName.get(scope.id)?.get(name) ?? [];
      for (let i = bindings.length - 1; i >= 0; i--) {
        const binding = bindings[i];
        if (binding.visibleFrom <= position && position < binding.visibleUntil) return binding;
      }
    }
    return;
  }

  private finishBindings(): void {
    for (const intent of [...this.facts.calls, ...this.facts.references]) {
      if (!["bare", "coderef", "named-coderef"].includes(intent.form)) continue;
      if (intent.name.kind !== "known" || intent.name.value.includes("::")) continue;
      const binding = this.binding(intent.name.value, intent.scopeId, intent.range.start);
      if (binding) intent.bindingId = binding.id;
    }
  }

  private requireInterpolation(node: Node): Node | null {
    const string = node.namedChildren.length === 1 ? node.firstNamedChild : null;
    if (string?.type !== "interpolated_string_literal" || string.hasError) return null;
    const content = string.childForFieldName("content");
    const scalar = content?.namedChildren.length === 1 ? content.firstNamedChild : null;
    if (scalar?.type !== "scalar" || !/^\$[A-Za-z_]\w*$/.test(scalar.text)) return null;
    return content!.text === `require ${scalar.text}` || content!.text === `require ${scalar.text};` ? scalar : null;
  }

  private finishStringEvals(root: Node): void {
    if (!this.stringEvals.length && !this.computedParents.length) return;
    // Only inspect the CST again for the uncommon finite-eval case. Scope
    // ranges retain lexical identity across shadowing and compiled closures.
    const scopes = [...this.facts.scopes].sort((a, b) => (a.range.end - a.range.start) - (b.range.end - b.range.start));
    const scopeAt = (node: Node) => scopes.find(scope => scope.range.start <= node.startIndex && node.endIndex <= scope.range.end)!;
    const bindingAt = (name: string, node: Node) => this.binding(name, scopeAt(node).id, node.startIndex);
    const scalarName = (node: Node) => node.firstNamedChild?.type === "varname" ? `$${node.firstNamedChild.text}` : node.text;
    const controlUnknown = this.hasParseErrors || descendants(root, n => n.type === "statement_label" || n.type === "label"
      || n.type === "loopex_expression" && /^goto\b/.test(n.text)).length > 0;
    const laterRuntime = (node: Node, site: Node) => {
      if (node.startIndex <= site.endIndex || !perlFileExecution(this.facts, scopeAt(node).id)) return false;
      for (let parent: Node | null = node; parent; parent = parent.parent) {
        if (["use_statement", "use_version_statement", "phaser_statement", "class_phaser_statement"].includes(parent.type)) return false;
      }
      return true;
    };
    const finiteValues = (scalar: Node, site: Node, ctx: WalkContext): string[] | null => {
      const binding = bindingAt(scalar.text, scalar), init = binding && this.stringInitializers.get(binding.id);
      if (!binding || !init || controlUnknown || ctx.phase !== "runtime" || ctx.conditional
        || !perlFileExecution(this.facts, ctx.scope.id) || init.context.phase !== "runtime" || init.context.conditional
        || !perlFileExecution(this.facts, init.context.scopeId) || init.context.range.end > site.startIndex) return null;
      const values = new Set([init.value]);
      for (const { node: other } of this.stringEvals) {
        if (laterRuntime(other, site) || bindingAt(scalar.text, other)?.id !== binding.id) continue;
        // An unrestricted string eval can write any visible lexical, even
        // without a CST reference to its name. Only this same bounded template
        // is harmless to the binding being proved.
        const ref = this.requireInterpolation(other);
        if (!ref || bindingAt(ref.text, ref)?.id !== binding.id) return null;
      }
      for (const node of descendants(root, n => n.type === "scalar" || OPAQUE_PERL.has(n.type))) {
        if (laterRuntime(node, site) || bindingAt(scalar.text, node)?.id !== binding.id) continue;
        if (OPAQUE_PERL.has(node.type)) {
          if (hasEmbeddedCode(node)) {
            // A single /e replacement that never names this lexical and has
            // no nested eval cannot write it. /ee and regex code assertions
            // can introduce another lexical eval and remain opaque here.
            const replacement = node.namedChildren.find(child => child.type === "replacement");
            const modifiers = node.namedChildren.find(child => child.type === "substitution_regexp_modifiers")?.text ?? "";
            const pattern = node.namedChildren.find(child => child.type === "regexp_content")?.text ?? "";
            if (node.type !== "substitution_regexp" || !replacement || modifiers.split("e").length !== 2
              || /\(\?\??\{/.test(pattern) || /\beval(?:bytes)?\b|\bgoto\b/.test(replacement.text)
              || replacement.text.includes(scalar.text.slice(1))) return null;
          }
          continue;
        }
        if (scalarName(node) !== scalar.text) continue;
        if (node.id === scalar.id) continue;
        const parent = node.parent;
        if (parent?.type === "assignment_expression" && parent.childForFieldName("left")?.id === node.id) {
          const rhs = parent.childForFieldName("right"), value = literalString(rhs);
          if (!rhs || value === null || this.source.slice(node.endIndex, rhs.startIndex).trim() !== "=") return null;
          values.add(value);
        } else if (parent?.type === "string_content" && parent.parent?.parent?.type === "eval_expression"
          && this.requireInterpolation(parent.parent.parent)?.id === node.id) {
          // String interpolation copies the value; it cannot expose an alias.
        } else return null; // references, unknown calls, lvalues, and captures
        if (values.size > 8) return null;
      }
      return [...values].every(value => PERL_NAME.test(value)) ? [...values].sort() : null;
    };
    for (const { node, ctx } of this.stringEvals) {
      const scalar = this.requireInterpolation(node), values = scalar && finiteValues(scalar, node, ctx);
      if (values) {
        for (const value of values) this.facts.loads.push({ ...this.context(node, ctx), id: `${this.file}:load${this.facts.loads.length}`,
          operation: "require", targetKind: "module", target: known(value), arguments: { kind: "empty" }, trapped: true,
          conditional: ctx.conditional || values.length > 1 });
      } else {
        this.diagnostic("PERL_DYNAMIC_EVAL", "String eval is not statically expanded", node);
        this.facts.mutations.push({ ...this.context(node, ctx), names: unknown("string eval can change package bindings") });
        this.facts.includeEffects.push({ ...this.context(node, ctx), operation: "unknown", directories: unknown("string eval can change load state"), affectsLoaded: true, affectsCwd: true });
      }
    }
    for (const { fact, node, scalar, ctx } of this.computedParents) {
      const values = finiteValues(scalar, node, ctx);
      if (!values) continue;
      fact.unknownMutation = false;
      if (values.length === 1) fact.parents = known(values);
      else fact.parentAlternatives = values.map(value => [value]);
    }
  }

  private mergeDeclarations(): void {
    const groups = new Map<string, DraftDefinition[]>();
    for (const draft of this.drafts) {
      if (draft.fact.kind === "callback") continue;
      const key = `${draft.fact.kind}:${draft.fact.qualifiedName}:${draft.fact.kind === "lexical-sub" ? draft.fact.scopeId : ""}`;
      const group = groups.get(key) ?? [];
      group.push(draft); groups.set(key, group);
    }
    const removed = new Set<string>();
    const remap = new Map<string, string>();
    for (const group of groups.values()) {
      const bodies = group.filter((d) => d.fact.hasBody);
      if (bodies.length > 1 || group.some((d) => d.fact.conditional)) continue;
      const chosen = bodies[0] ?? group[0];
      const id = group[0].node.id;
      chosen.fact.declarations = group.map((d) => d.fact.range);
      for (const draft of group) {
        remap.set(draft.node.id, id);
        if (draft !== chosen) removed.add(draft.node.id);
      }
      // Filter before IDs are changed: the chosen body can acquire the removed
      // forward declaration's original ID without being removed itself.
    }
    this.result.nodes = this.result.nodes.filter((n) => !removed.has(n.id));
    this.facts.definitions = this.facts.definitions.filter((d) => !removed.has(d.nodeId));
    this.result.rawEdges = this.result.rawEdges.filter((e) => !removed.has(e.targetId ?? ""));
    const mapped = (id: string) => remap.get(id) ?? id;
    for (const node of this.result.nodes) node.id = mapped(node.id);
    for (const definition of this.facts.definitions) definition.nodeId = mapped(definition.nodeId);
    for (const edge of this.result.rawEdges) { edge.source = mapped(edge.source); if (edge.targetId) edge.targetId = mapped(edge.targetId); }
    for (const scope of this.facts.scopes) scope.ownerNode = mapped(scope.ownerNode);
    for (const context of [...this.facts.calls, ...this.facts.references, ...this.facts.loads, ...this.facts.includeEffects, ...this.facts.mutations, ...this.facts.inheritance, ...this.facts.frameworks]) context.sourceNode = mapped(context.sourceNode);
    for (const binding of this.facts.bindings) if (binding.target.kind === "known" && "nodeId" in binding.target.value) binding.target.value.nodeId = mapped(binding.target.value.nodeId);
  }

  private finishExports(): void {
    const customImporters = new Set(this.facts.definitions.filter((d) => d.kind === "package-sub" && d.name === "import" && d.hasBody).map((d) => d.packageName));
    for (const fact of this.facts.exports) fact.exporter = customImporters.has(fact.packageName) ? "unknown" : this.exporter.get(fact.packageName) ?? "unknown";
    for (const definition of this.facts.definitions) {
      if (!["package-sub", "constant"].includes(definition.kind)) continue;
      const entries = this.facts.exports.filter((e) => e.packageName === definition.packageName);
      const tables = new Map<string, Set<string>>();
      for (const entry of entries) {
        const key = `${entry.kind}:${entry.tag ?? ""}`;
        if (entry.operation === "replace") tables.set(key, new Set());
        const names = tables.get(key) ?? new Set<string>();
        if (entry.symbols.kind === "known") for (const name of entry.symbols.value) names.add(name.replace(/^&/, ""));
        tables.set(key, names);
      }
      const exported = ["default:", "optional:"].some((key) => tables.get(key)?.has(definition.name)) && entries.every((e) => e.exporter !== "unknown" && !e.unknownMutation && e.symbols.kind === "known");
      const node = this.result.nodes.find((n) => n.id === definition.nodeId);
      if (node) node.exported = exported;
    }
  }
}
