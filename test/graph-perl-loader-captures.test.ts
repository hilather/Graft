import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

const overlay = String.raw`package P; my $previous = \&original; *original = sub { goto &$previous }; 1;`;
const diagnostics = (f: ReturnType<typeof perlRepo>) => JSON.parse(readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8")).files;

test("an overlay captures its loader's original method before replacing the slot", async () => {
  const f = perlRepo({ "lib/P.pm": "package P; sub original {} require P_Local; 1;", "lib/P_Local.pm": overlay, "main.pl": "use P (); P::original();" });
  try {
    await f.build();
    const wrapper = f.graph().nodes.find(node => node.name === "*original")!;
    assert.deepEqual(semanticEdges(f.graph()), [
      `${wrapper.id} -> lib/P.pm#P::original [inferred]`,
      `main.pl -> ${wrapper.id} [extracted]`,
    ].sort());
    assert.deepEqual(diagnostics(f)["lib/P_Local.pm"].diagnostics, []);
    const cold = f.bytes();
    assert.equal((await f.build()).parsed, 0);
    assert.equal(f.bytes(), cold);
  } finally { f.close(); }
});

test("a captured original follows earlier aliases and overlays but ignores later loads", async () => {
  for (const [source, target] of [
    [String.raw`package P; sub original {} sub alternate {} *original = \&alternate; require P_Local; require Late; 1;`, "lib/P.pm#P::alternate"],
    ["package P; sub original {} require Vendor; require P_Local; require Late; 1;", "lib/Vendor.pm#P::original"],
    ["package P; sub original {} sub unused { *original = sub {} } require P_Local; require Late; 1;", "lib/P.pm#P::original"],
    ["package P; sub original {} require Middle; require Late; 1;", "lib/P.pm#P::original"],
  ]) {
    const f = perlRepo({ "lib/P.pm": source, "lib/P_Local.pm": overlay, "lib/Vendor.pm": "package P; sub original {} 1;",
      ...(source.includes("require Middle") ? { "lib/Middle.pm": "package Middle; require P_Local; 1;" } : {}),
      "lib/Late.pm": "package P; sub original {} 1;", "main.pl": "use P ();" });
    try {
      await f.build();
      const wrapper = f.graph().nodes.find(node => node.name === "*original")!;
      assert.ok(semanticEdges(f.graph()).includes(`${wrapper.id} -> ${target} [inferred]`), source);
      assert.ok(!semanticEdges(f.graph()).includes(`${wrapper.id} -> lib/Late.pm#P::original [inferred]`), source);
    } finally { f.close(); }
  }
});

test("capture proof requires every resolved loading path to pass through the defining module", async () => {
  for (const extra of [
    { "direct.pl": "require P_Local;" },
    { "lib/Q.pm": "package P; sub original {} require P_Local; 1;", "other.pl": "use Q ();" },
    { "direct.pl": "require Middle;" },
  ]) {
    const f = perlRepo({ "lib/P.pm": "package P; sub original {} require Middle; 1;", "lib/Middle.pm": "package Middle; require P_Local; 1;", "lib/P_Local.pm": overlay, "main.pl": "use P ();", ...extra });
    try {
      await f.build();
      assert.ok(!semanticEdges(f.graph()).some(edge => edge.startsWith("lib/P_Local.pm#") && / -> lib\/P\.pm#P::original /.test(edge)), JSON.stringify(extra));
    } finally { f.close(); }
  }
});

test("loader captures respect imports and later compiled declarations", async () => {
  for (const [source, target] of [
    ["package P; sub original {} use Source qw(original); require P_Local; 1;", "lib/Source.pm#Source::original"],
    ["package P; use Source qw(original); sub original {} require P_Local; 1;", "lib/P.pm#P::original"],
  ]) {
    const f = perlRepo({ "lib/P.pm": source, "lib/P_Local.pm": overlay,
      "lib/Source.pm": "package Source; use Exporter 'import'; our @EXPORT_OK = qw(original); sub original {} 1;", "main.pl": "use P ();" });
    try {
      await f.build();
      assert.ok(semanticEdges(f.graph()).some(edge => edge.startsWith("lib/P_Local.pm#") && edge.endsWith(` -> ${target} [inferred]`)), source);
    } finally { f.close(); }
  }
});

test("later definitions, repeated initialization, and opaque prior effects do not prove captures", async () => {
  for (const source of [
    "package P; require P_Local; require Late; 1;",
    "package P; sub original {} do 'lib/P_Local.pm'; do 'lib/P_Local.pm'; 1;",
    "package P; sub original {} require P_Local; delete $INC{'P_Local.pm'}; require P_Local; 1;",
    "package P; sub original {} require P_Local; require './lib/P_Local.pm'; 1;",
    "package P; sub original {} require Missing; require P_Local; 1;",
    "package P; sub original {} external(); require P_Local; 1;",
    "package P; sub original {} sub change { external() } change(); require P_Local; 1;",
    "package P; sub original {} sub change { *original = sub {} } change(); require P_Local; 1;",
    "package P; sub original {} if ($flag) { require P_Local } 1;",
    "package P; BEGIN { *CORE::GLOBAL::length = sub { *P::original = sub {} } } sub original {} length 'payload'; require P_Local; 1;",
  ]) {
    const f = perlRepo({ "lib/P.pm": source, "lib/P_Local.pm": overlay, "lib/Late.pm": "package P; sub original {} 1;", "main.pl": "use P ();" });
    try {
      await f.build();
      assert.ok(!semanticEdges(f.graph()).some(edge => edge.startsWith("lib/P_Local.pm#") && / -> lib\/(P|Late)\.pm#P::original /.test(edge)), source);
      assert.ok(JSON.stringify(diagnostics(f)["lib/P_Local.pm"]).includes("Cannot establish one source target for $previous"), source);
    } finally { f.close(); }
  }
});

test("known initializer calls retain precise effects and run before enclosing assignments", async () => {
  for (const source of [
    "package P; sub original {} sub harmless { return 1 } harmless(); require P_Local; 1;",
    String.raw`package P; sub original {} sub helper {} sub other {} sub change { *other = \&helper } change(); require P_Local; 1;`,
  ]) {
    const f = perlRepo({ "lib/P.pm": source, "lib/P_Local.pm": overlay, "main.pl": "use P ();" });
    try {
      await f.build();
      assert.ok(semanticEdges(f.graph()).some(edge => edge.startsWith("lib/P_Local.pm#") && edge.endsWith(" -> lib/P.pm#P::original [inferred]")), source);
    } finally { f.close(); }
  }
  const f = perlRepo({ "lib/P.pm": "package P; sub original {} unknown(*original = sub {}); require P_Local; 1;", "lib/P_Local.pm": overlay, "main.pl": "use P ();" });
  try {
    await f.build();
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.startsWith("lib/P_Local.pm#") && edge.includes(" -> lib/P.pm#")));
  } finally { f.close(); }
});

test("a loader capture preserves callee identity while retaining later caller mutations", async () => {
  const f = perlRepo({
    "lib/P.pm": "package P; sub victim {} sub original { victim() } require P_Local; 1;",
    "lib/P_Local.pm": overlay,
    "main.pl": "use P (); *P::victim = sub {}; P::original();",
  });
  try {
    await f.build();
    assert.ok(semanticEdges(f.graph()).some(edge => edge.startsWith("lib/P_Local.pm#") && edge.endsWith(" -> lib/P.pm#P::original [inferred]")));
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.startsWith("lib/P.pm#P::original -> lib/P.pm#P::victim ")));
  } finally { f.close(); }
});
