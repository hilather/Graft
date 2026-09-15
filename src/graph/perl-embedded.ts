/** Parse /e replacement expressions as source, retaining original positions. */
import { Parser, type Language, type Node, type Tree } from "web-tree-sitter";

export function createPerlEmbeddedParser(language: Language, source: string) {
  let parser: Parser | undefined;
  const trees: Tree[] = [];
  let attempted = 0, units = 0;
  const parse = (replacement: Node): Node | null => {
    // The scanner omits leading whitespace from the replacement node. Use
    // its delimiter siblings so multiline expressions retain all their text.
    const siblings = replacement.parent?.children ?? [];
    const index = siblings.findIndex(node => node.id === replacement.id);
    const opening = siblings.slice(0, index).reverse().find(node => node.type === "'");
    const closing = siblings.slice(index + 1).find(node => node.type === "'");
    if (!opening || !closing) return null;
    const start = opening.startIndex, end = closing.startIndex;
    const open = opening.text, close = closing.text;
    // Quoting can remove escaped delimiters before Perl compiles /e. Keep
    // those forms unresolved until their source-position mapping is modeled.
    if (close.length !== 1 || !/^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]$/.test(open)
      || open === "\\" || replacement.text.includes(`\\${open}`) || replacement.text.includes(`\\${close}`)) return null;
    if (++attempted > 128 || (units += end - start) > 2_000_000) return null;
    parser ??= new Parser().setLanguage(language);
    const input = (index: number) => {
      const chunk = source.slice(index, index + 64).split("");
      if (start >= index && start < index + chunk.length) chunk[start - index] = "{";
      if (end >= index && end < index + chunk.length) chunk[end - index] = "}";
      return chunk.join("");
    };
    const tree = parser.parse(input, null, { includedRanges: [{
      startIndex: start, endIndex: end + 1,
      startPosition: opening.startPosition, endPosition: closing.endPosition,
    }] });
    if (!tree) return null;
    trees.push(tree);
    const block = tree.rootNode.firstNamedChild;
    if (tree.rootNode.hasError || tree.rootNode.namedChildCount !== 1 || block?.type !== "block_statement") return null;
    // The recovery scanner can emit a zero-width closing parenthesis without
    // setting hasError/isMissing. Such a recovered fragment is not proof.
    const pending = [block];
    while (pending.length) {
      const node = pending.pop()!;
      if ([")", "]", "}"].includes(node.type) && node.startIndex === node.endIndex) return null;
      pending.push(...node.children);
    }
    return block;
  };
  return { parse, dispose() { for (const tree of trees) tree.delete(); parser?.delete(); } };
}
