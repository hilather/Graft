import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFile } from "../src/graph/extract.js";

test("residual indexing matches the original line mask byte-for-byte for nested definitions, Unicode and CRLF", () => {
  const nested = `// outside α 😀\nconst marker = "module needle";\nexport class Outer {\n  method() {\n    function nested() {\n      return "inner";\n    }\n    return nested();\n  }\n}\n// tail\n`;
  const sources = ["", "// only outside\n", nested, nested.replaceAll("\n", "\r\n"), `// ${"😀 α ".repeat(5000)}\n${nested}`, "function broken( {\n// malformed tail\n"];
  for (const source of sources) {
    const result = extractFile("fixture.ts", source, "typescript");
    const lines = source.split("\n");
    const covered = new Uint8Array(lines.length + 2);
    for (const symbol of result.nodes.slice(1)) {
      const match = /^L(\d+)-L(\d+)$/.exec(symbol.span);
      if (!match) continue;
      for (let row = Number(match[1]); row <= Number(match[2]) && row < covered.length; row++) covered[row] = 1;
    }
    const expected = lines.filter((_, i) => !covered[i + 1]).join(" ").replace(/\s+/g, " ").trim().slice(0, 16000);
    assert.equal(result.nodes[0].body_text, expected);
  }
});
