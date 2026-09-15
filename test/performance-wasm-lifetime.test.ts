import { test } from "node:test";
import assert from "node:assert/strict";
import { Parser, Tree } from "web-tree-sitter";
import {
  extractGeneric, loadWasmLanguage, swapGrammarForTest,
  warmGenericGrammars, withWasmTree,
} from "../src/graph/generic.js";

test("WASM extraction releases owned resources on every exit path", async (t) => {
  await warmGenericGrammars(["rust"]);
  const language = await loadWasmLanguage("rust");
  assert.ok(language);
  const source = "pub fn helper() {}\npub fn main() { helper(); }\n";

  for (const route of ["generic", "scoped"] as const) {
    for (const outcome of ["success", "null", "parse failure", "setup failure", "consumer failure"] as const) {
      await t.test(`${route}: ${outcome}`, (t) => {
        const parsers = t.mock.method(Parser.prototype, "delete");
        const trees = t.mock.method(Tree.prototype, "delete");
        if (outcome === "null") t.mock.method(Parser.prototype, "parse", () => null);
        if (outcome === "parse failure") t.mock.method(Parser.prototype, "parse", () => { throw new Error("parse failed"); });
        if (outcome === "setup failure") t.mock.method(Parser.prototype, "setLanguage", () => { throw new Error("setup failed"); });
        let restore: ReturnType<typeof swapGrammarForTest> | undefined;
        if (route === "generic" && outcome === "consumer failure") {
          restore = swapGrammarForTest("rust", {
            language, query: { matches() { throw new Error("consumer failed"); } },
          });
        }
        try {
          const run = () => route === "generic"
            ? extractGeneric("lib.rs", source, "rust")
            : withWasmTree(language, source, (root) => {
              if (outcome === "consumer failure") throw new Error("consumer failed");
              assert.equal(root !== null, outcome === "success");
              // Nodes must remain usable until the consumer has completed.
              if (root) assert.equal(root.text, source);
              assert.equal(trees.mock.callCount(), 0);
              return root?.type;
            });
          if (outcome === "consumer failure" || (route === "generic" && outcome.endsWith("failure"))) {
            assert.throws(run, route === "generic" && outcome !== "consumer failure" ? /rust grammar threw:/ : /consumer failed/);
          } else {
            const result = run();
            if (route === "generic" && outcome === "success") {
              assert.equal(typeof result, "object");
              assert.equal((result as ReturnType<typeof extractGeneric>).nodes.length, 3);
            }
          }
          assert.equal(parsers.mock.callCount(), 1);
          assert.equal(trees.mock.callCount(), outcome === "success" || outcome === "consumer failure" ? 1 : 0);
        } finally {
          if (restore !== undefined) swapGrammarForTest("rust", restore);
        }
      });
    }
  }
});
