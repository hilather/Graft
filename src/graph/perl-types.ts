/** File-local, JSON-only Perl contracts. All paths are repository-relative POSIX;
 * offsets are half-open UTF-16 code-unit indexes into decoded source. */
import type { RawEdge } from "./extract.js";
import type { NodeV1, Confidence } from "./types.js";

export const PERL_FACTS_VERSION = 10 as const;
export const PERL_MAX_SOURCE_CODE_UNITS = 2_000_000;

export interface PerlRange {
  start: number;
  end: number;
  /** One-based inclusive display lines. */
  startLine: number;
  endLine: number;
}

export interface PerlDiagnostic {
  code: string;
  file: string;
  severity: "warning" | "error";
  message: string;
  range?: PerlRange;
}

export interface PerlScope {
  id: string;
  parent: string | null;
  kind: "file" | "block" | "sub" | "callback" | "phaser" | "class";
  ownerNode: string;
  range: PerlRange;
  /** An erroneous package boundary prevents exact binding in this scope. */
  contextKnown: boolean;
}

export interface PerlPackageRegion {
  name: string;
  nodeId: string;
  scopeId: string;
  kind: "package" | "class" | "role";
  range: PerlRange;
  declaration: PerlRange;
}

export interface PerlDefinition {
  nodeId: string;
  name: string;
  qualifiedName: string;
  packageName: string;
  packageNode: string | null;
  scopeId: string;
  kind: "package-sub" | "lexical-sub" | "callback" | "method" | "constant" | "field" | "phaser";
  range: PerlRange;
  /** Forward declarations share one node with their unique unambiguous body. */
  declarations: PerlRange[];
  hasBody: boolean;
  conditional: boolean;
  /** Bounded literal scalar evidence for a compile-time constant sub. */
  inlineConstant?: true;
}

export type PerlKnown<T> = { kind: "known"; value: T } | { kind: "unknown"; reason: string };
export type PerlPhase = "compile" | "runtime" | "BEGIN" | "UNITCHECK" | "CHECK" | "INIT" | "END" | "ADJUST";

export interface PerlContext {
  sourceNode: string;
  packageName: string;
  scopeId: string;
  range: PerlRange;
  phase: PerlPhase;
  conditional: boolean;
}

export type PerlImportArguments =
  | { kind: "default" }
  | { kind: "empty" }
  | { kind: "list"; symbols: string[] }
  | { kind: "unknown"; reason: string };

export interface PerlLoad extends PerlContext {
  id: string;
  operation: "use" | "no" | "require" | "do";
  targetKind: "module" | "file" | "version" | "pragma" | "dynamic";
  target: PerlKnown<string>;
  arguments: PerlImportArguments;
  /** Source-declared adapters can cause module loads without another use node. */
  implicit?: "parent" | "base" | "class" | "framework";
  viaLoadId?: string;
  /** A literal eval require attempts a known load but traps its failure. */
  trapped?: boolean;
}

export interface PerlIncludeEffect extends PerlContext {
  operation: "prepend" | "append" | "replace" | "remove" | "unknown";
  directories: PerlKnown<string[]>;
  /** A %INC mutation also invalidates already-loaded module identity. */
  affectsLoaded?: boolean;
  affectsCwd?: boolean;
}

export interface PerlSymbolMutation extends PerlContext {
  names: PerlKnown<string[]>;
  /** A literal CODE-slot assignment captures this reference at assignment time. */
  aliasReference?: PerlReference;
  /** A directly assigned anonymous CODE value, separate from the old slot. */
  replacementNodeId?: string;
  /** Literal signature-free sub {} replacement has no reentrant body effects. */
  emptyReplacement?: true;
  mechanism?: "framework";
  frameworkEffect?: "generated" | "modifier";
}

export interface PerlBinding {
  id: string;
  scopeId: string;
  packageName: string;
  /** Sigils are part of variable identity: $x, @x, %x never share a binding. */
  name: string;
  kind: "lexical-sub" | "lexical-coderef" | "lexical-variable" | "package-alias" | "our-alias";
  target: PerlKnown<{ nodeId: string } | { loadId: string; exportedName: string }>;
  /** Resolve this CODE reference at initialization, before later slot changes. */
  captureReference?: PerlReference;
  range: PerlRange;
  visibleFrom: number;
  visibleUntil: number;
  invalidations: { at: number; reason: "assignment" | "escape" | "unimport" | "conditional" | "mutation" }[];
  /** Bounded local receiver evidence; a call to a sub named new is insufficient. */
  receiver?: PerlReceiver;
}

export interface PerlExport {
  packageName: string;
  scopeId: string;
  range: PerlRange;
  exporter: "import" | "inheritance" | "unknown";
  kind: "default" | "optional" | "tag";
  tag?: string;
  symbols: PerlKnown<string[]>;
  operation: "replace" | "append";
  unknownMutation: boolean;
  /** A whole %EXPORT_TAGS assignment clears tags from earlier assignments. */
  resetTags?: boolean;
}

export type PerlReceiver =
  | { kind: "package"; packageName: string }
  | { kind: "lexical"; bindingId: string }
  | { kind: "bless"; packageName: string; range: PerlRange }
  | { kind: "declared-self"; packageName: string }
  | { kind: "super"; lexicalPackage: string }
  | { kind: "unknown"; reason: string };

export interface PerlCall extends PerlContext {
  form: "bare" | "qualified" | "method" | "coderef" | "dynamic";
  name: PerlKnown<string>;
  receiver?: PerlReceiver;
  /** A known lexical binding is distinct from a package/global name. */
  bindingId?: string;
  /** A bareword needs prior compile-time declaration/import evidence. */
  syntax?: "bareword" | "ampersand" | "builtin";
  /** An explicit function invocation has no argument expressions. */
  emptyArguments?: true;
  /** A grammar alternative is an expression only if this preceding same-unit
   * constant was inlined at its compilation position. */
  requiresInlineConstant?: { name: string; position: number };
}

export interface PerlReference extends PerlContext {
  form: "named-coderef" | "role" | "modifier" | "dynamic";
  name: PerlKnown<string>;
  bindingId?: string;
}

export interface PerlInheritance extends PerlContext {
  parents: PerlKnown<string[]>;
  /** Finite alternatives for one append; these are choices, not simultaneous parents. */
  parentAlternatives?: string[][];
  operation: "replace" | "append";
  mechanism: "parent" | "base" | "ISA" | "class" | "framework" | "mro";
  noRequire: boolean;
  mro: "dfs" | "c3" | "unknown";
  unknownMutation: boolean;
  loadIds?: string[];
  adapterLoadId?: string;
  /** A computed MRO helper target may name any reachable package. */
  allPackages?: boolean;
}

export interface PerlFramework extends PerlContext {
  framework: "Moo" | "Moose" | "Moo::Role" | "Moose::Role";
  declaration: "import" | "extends" | "with" | "has" | "before" | "after" | "around";
  names: PerlKnown<string[]>;
  callbackNodes: string[];
  options: { name: string; value: PerlKnown<string | number | boolean | null> }[];
  importLoadId?: string;
  packageNode?: string;
  loadIds?: string[];
  /** Draft source nodes only become public after repository identity checks. */
  attributes?: NodeV1[];
  callbacks?: { node: NodeV1; scopeId: string; range: PerlRange; ownerNode: string; parentNode: string }[];
}

export interface PerlFileFacts {
  language: "perl";
  version: typeof PERL_FACTS_VERSION;
  file: string;
  packages: PerlPackageRegion[];
  definitions: PerlDefinition[];
  scopes: PerlScope[];
  bindings: PerlBinding[];
  loads: PerlLoad[];
  includeEffects: PerlIncludeEffect[];
  mutations: PerlSymbolMutation[];
  /** Labels/nonlocal control prevent straight-line execution-order proofs. */
  initializationOrderUnknown?: true;
  exports: PerlExport[];
  calls: PerlCall[];
  references: PerlReference[];
  inheritance: PerlInheritance[];
  frameworks: PerlFramework[];
  diagnostics: PerlDiagnostic[];
}

export interface PerlExtractResult {
  nodes: NodeV1[];
  /** Perl emits contains here; semantic intents never enter generic fallback. */
  rawEdges: RawEdge[];
  languageData: PerlFileFacts;
  status: "ok" | "partial" | "failed";
  /** Transient load/crash/timeout failures must be retried by the next build. */
  cacheable: boolean;
}

export interface PerlParseJob {
  id: number;
  file: string;
  source: string;
  mode: "source" | "pod";
}

export type PerlWorkerMessage =
  | { type: "ready" }
  | { type: "result"; id: number; result: PerlExtractResult }
  | { type: "fatal"; code: string; message: string };

/** Runtime-only resolver indexes may use Maps/Sets; cached file facts may not. */
export interface PerlModuleTarget {
  file: string;
  confidence: Extract<Confidence, "extracted" | "inferred">;
  root: string;
}

export interface PerlModuleEnvironment {
  loads: ReadonlyMap<string, PerlModuleTarget>;
  packageFiles: ReadonlyMap<string, readonly string[]>;
  /** Explicit load reachability, including script-local main execution contexts. */
  reachableFiles: ReadonlyMap<string, ReadonlySet<string>>;
  /** Caller file -> reachable file -> weakest load-chain provenance. */
  reachability: ReadonlyMap<string, ReadonlyMap<string, PerlModuleTarget["confidence"]>>;
  imports: ReadonlyMap<string, readonly PerlImportedBinding[]>;
  unknownImports: ReadonlySet<string>;
  /** Provenance for compile-order shadowing. Missing provenance stays unknown. */
  unknownImportLoads?: ReadonlyMap<string, readonly string[]>;
  unresolved: readonly PerlDiagnostic[];
}

export interface PerlImportedBinding {
  file: string;
  packageName: string;
  name: string;
  providerFile: string;
  providerPackage: string;
  exportedName: string;
  confidence: PerlModuleTarget["confidence"];
  loadId: string;
}
