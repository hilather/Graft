import { test } from "node:test";
import assert from "node:assert/strict";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

test("recursive shared callers retain every mutation while independent entries keep their own state", async () => {
  const names = Array.from({ length: 70 }, (_, i) => `target${i}`);
  const files: Record<string, string> = {
    "lib/Shared.pm": `package Shared;
${names.map(name => `sub ${name} {}`).join("\n")}
sub unchanged {}
sub run { ${names.map(name => `${name}();`).join(" ")} unchanged(); }
sub first { second() if $flag; run(); }
sub second { first() if $flag; run(); }
1;`,
    "independent.pl": "use Shared (); Shared::target69();",
  };
  for (let group = 0; group < 3; group++) {
    files[`caller${group}.pl`] = `use Shared ();
${names.filter((_, i) => i % 3 === group).map(name => `*Shared::${name} = sub {};`).join("\n")}
Shared::first(); Shared::second();`;
  }
  const f = perlRepo(files);
  try {
    await f.build();
    const edges = semanticEdges(f.graph());
    assert.ok(edges.includes("lib/Shared.pm#Shared::run -> lib/Shared.pm#Shared::unchanged [extracted]"));
    assert.ok(!edges.some(edge => edge.startsWith("lib/Shared.pm#Shared::run -> lib/Shared.pm#Shared::target")));
    assert.ok(edges.includes("independent.pl -> lib/Shared.pm#Shared::target69 [extracted]"));
    const cold = f.bytes();
    assert.equal((await f.build()).parsed, 0);
    assert.equal(f.bytes(), cold);
  } finally { f.close(); }
});
