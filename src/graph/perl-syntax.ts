/** Small CST readers. They accept literal syntax only and never evaluate Perl. */
import type { Node } from "web-tree-sitter";
import type { PerlImportArguments, PerlKnown } from "./perl-types.js";

export const known = <T>(value: T): PerlKnown<T> => ({ kind: "known", value });
export const unknown = <T>(reason: string): PerlKnown<T> => ({ kind: "unknown", reason });
export const PERL_NAME = /^[\p{L}_][\p{L}\p{N}_]*(?:::[\p{L}_][\p{L}\p{N}_]*)*$/u;
export const PERL_VARIABLE = /^[$@%][\p{L}_][\p{L}\p{N}_]*(?:::[\p{L}_][\p{L}\p{N}_]*)*$/u;

/** Builtin list operators emitted as ordinary function nodes by the pinned
 * grammar (_listop_keyword and _indirob_listop). Unary builtin CST nodes carry
 * explicit builtin syntax instead. Ordinary package declarations cannot
 * override these names: perlsub, "Overriding Built-in Functions". */
export const PERL_LIST_BUILTINS = new Set(`accept atan2 bind binmode bless crypt chmod chown connect die dbmopen fcntl flock getpriority getprotobynumber gethostbyaddr getnetbyaddr getservbyname getservbyport getsockopt glob index ioctl join kill link listen mkdir msgctl msgget msgrcv msgsend opendir push pack pipe rename rindex read recv reverse select seek semctl semget semop send setpgrp setpriority seekdir setsockopt shmctl shmread shmwrite shutdown socket socketpair split sprintf splice substr symlink syscall sysopen sysseek sysread syswrite tie truncate unlink unpack utime unshift vec warn waitpid formline open print printf say exec system`.split(" "));

export const OPAQUE_PERL = new Set([
  "comment", "pod", "data_section", "end_section", "heredoc_body", "heredoc_content", "heredoc_token", "command_heredoc_token",
  "string_literal", "interpolated_string_literal", "command_string", "quoted_word_list",
  "quoted_regexp", "match_regexp", "substitution_regexp", "transliteration_expression",
]);

export function descendants(node: Node, predicate: (n: Node) => boolean): Node[] {
  const found: Node[] = [];
  const stack = [node];
  while (stack.length) {
    const next = stack.pop()!;
    if (predicate(next)) found.push(next);
    stack.push(...[...next.namedChildren].reverse());
  }
  return found;
}

export function literalString(node: Node | null): string | null {
  if (!node || node.hasError) return null;
  const type = node.type;
  if (type === "autoquoted_bareword") return node.text;
  if (type !== "string_literal" && type !== "interpolated_string_literal") return null;
  const content = node.childForFieldName("content");
  if (!content) return "";
  // Scalar/array interpolation, escapes whose value depends on Perl rules,
  // and embedded executable syntax cannot become a proven name or path.
  if (content.namedChildren.length) return null;
  const text = content.text;
  return /\\/.test(text) ? null : text;
}

export function expressionItems(node: Node): Node[] {
  const type = node.type;
  if (type === "parenthesized_expression" || type === "list_expression") return node.namedChildren.flatMap(expressionItems);
  return [node];
}

/** Names are independent of a single constant's computed or list value. A
 * hash declaration needs scalar values so list expansion cannot shift keys. */
export function constantNames(args: Node): PerlKnown<string[]> {
  if (args.hasError) return unknown("constant declaration intersects a parse error");
  const items = expressionItems(args);
  const hash = items.length === 1 && items[0].type === "anonymous_hash_expression" ? items[0] : null;
  if (!hash) {
    const name = literalString(items[0] ?? null);
    return name && PERL_NAME.test(name) ? known([name]) : unknown("computed constant name");
  }
  const pairs = hash.namedChildren.flatMap(expressionItems);
  const names: string[] = [];
  if (pairs.length % 2) return unknown("constant hash does not have static key/value pairs");
  for (let i = 0; i < pairs.length; i += 2) {
    const name = literalString(pairs[i]);
    const value = pairs[i + 1];
    const scalar = ["number", "string_literal", "interpolated_string_literal", "autoquoted_bareword", "scalar", "undef_expression",
      "postinc_expression", "postdec_expression", "preinc_expression", "predec_expression", "anonymous_array_expression", "anonymous_hash_expression"].includes(value.type);
    if (!name || !PERL_NAME.test(name) || !scalar) return unknown("constant hash needs literal names and scalar values");
    names.push(name);
  }
  return known([...new Set(names)]);
}

/** Only literal scalar values establish this proof. A constant's name can
 * still be indexed when its computed, list or reference value is unmodeled. */
export function inlineConstantNames(args: Node): Set<string> {
  if (args.hasError) return new Set();
  const items = expressionItems(args);
  const hash = items.length === 1 && items[0].type === "anonymous_hash_expression" ? items[0] : null;
  const pairs = hash ? hash.namedChildren.flatMap(expressionItems) : items;
  if ((!hash && pairs.length !== 2) || pairs.length % 2) return new Set();
  const candidates = new Map<string, boolean>();
  for (let i = 0; i < pairs.length; i += 2) {
    const name = literalString(pairs[i]), value = pairs[i + 1];
    if (!name || !PERL_NAME.test(name)) return new Set();
    candidates.set(name, value.type === "number" || value.type === "undef_expression" || literalString(value) !== null);
  }
  // A repeated hash key keeps its last value, not an earlier literal value.
  return new Set([...candidates].filter(([, inline]) => inline).map(([name]) => name));
}

export function literalList(node: Node | null): PerlKnown<string[]> {
  if (!node) return known([]);
  if (node.hasError) return unknown("literal list intersects a parse error");
  const type = node.type;
  if (type === "stub_expression") return known([]);
  if (type === "quoted_word_list") {
    const text = node.childForFieldName("content")?.text ?? "";
    return /\\/.test(text) ? unknown("escaped word list is not modeled") : known(text.trim() ? text.trim().split(/\s+/) : []);
  }
  if (type === "parenthesized_expression" || type === "list_expression" || type === "anonymous_array_expression") {
    const values: string[] = [];
    for (const child of node.namedChildren) {
      const list = literalList(child);
      if (list.kind === "unknown") return list;
      values.push(...list.value);
    }
    return known(values);
  }
  const value = literalString(node);
  return value === null ? unknown("computed or nonliteral list") : known([value]);
}

export function importArguments(node: Node | null): PerlImportArguments {
  if (!node) return { kind: "default" };
  const list = literalList(node);
  if (list.kind === "unknown") return list;
  return list.value.length ? { kind: "list", symbols: list.value } : { kind: "empty" };
}

/** parent alone recognizes its leading -norequire switch. It is not a
 * general literal expression: arbitrary unary expressions stay unknown. */
export function parentArguments(node: Node | null): { parents: PerlKnown<string[]>; noRequire: boolean } {
  const items = node ? expressionItems(node) : [];
  const noRequire = items[0]?.text === "-norequire" || literalString(items[0] ?? null) === "-norequire";
  const values: string[] = [];
  for (const item of noRequire ? items.slice(1) : items) {
    const list = literalList(item);
    if (list.kind === "unknown") return { parents: list, noRequire };
    values.push(...list.value);
  }
  return { parents: values.every((value) => PERL_NAME.test(value)) ? known(values) : unknown("unsupported parent name"), noRequire };
}

export function variableName(node: Node | null): string | null {
  if (!node) return null;
  const type = node.type;
  if (type === "variable_declaration") return variableName(node.childForFieldName("variable"));
  if (!["scalar", "array", "hash", "glob"].includes(type)) return null;
  const text = node.text;
  return /^[$@%*][\p{L}_][\p{L}\p{N}_]*(?:::[\p{L}_][\p{L}\p{N}_]*)*$/u.test(text) ? text : null;
}

export function packageNameOf(name: string, current: string): { name: string; packageName: string; qualifiedName: string } {
  const cut = name.lastIndexOf("::");
  return cut < 0 ? { name, packageName: current, qualifiedName: `${current}::${name}` } : { name: name.slice(cut + 2), packageName: name.slice(0, cut), qualifiedName: name };
}

export function hasEmbeddedCode(node: Node): boolean {
  const type = node.type;
  if (type === "substitution_regexp" && /e/.test(node.childForFieldName("modifiers")?.text ?? "")) return true;
  if (["quoted_regexp", "match_regexp", "substitution_regexp"].includes(type)) {
    const pattern = node.childForFieldName("content")?.text ?? "";
    if (/(?:^|[^\\])(?:\\\\)*\(\?\??\{/.test(pattern)) return true;
  }
  return descendants(node, (n) => n !== node && ["block", "function_call_expression", "method_call_expression", "coderef_call_expression"].includes(n.type)).length > 0;
}
