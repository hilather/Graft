import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { perlRepo, utilSource, runnerSource } from "./helpers/perl-repo.js";
import { resolveSymbol, callersOf, edgeWalk } from "../src/graph/traverse.js";
import { buildRepoMap } from "../src/graph/map.js";
import { writeCards } from "../src/graph/cards.js";
import { buildContext, CODE_EXTENSIONS, listContextFiles } from "../src/context/build.js";
import { checkContext } from "../src/context/check.js";
import { readManifest } from "../src/context/node-file.js";
import { fakeProviders } from "./helpers.js";
import matter from "gray-matter";

test("Perl qualified names and full IDs are exact and never fall back to another package", async () => {
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource, "lib/Other.pm": "package Other; sub normalize {}", "duplicate.pm": "package Acme::Util; sub normalize {} sub normalize {}" });
  try {
    await f.build(); const graph = f.graph();
    const id = "lib/Acme/Util.pm#Acme::Util::normalize";
    assert.deepEqual(resolveSymbol(graph, id).map((n) => n.id), [id]);
    assert.deepEqual(resolveSymbol(graph, id.toLowerCase()), []);
    assert.deepEqual(resolveSymbol(graph, "Acme::Util::normalize").map((n) => n.id).sort(), ["duplicate.pm#Acme::Util::normalize", "duplicate.pm#Acme::Util::normalize~2", id]);
    assert.deepEqual(resolveSymbol(graph, "acme::util::normalize"), []);
    assert.deepEqual(resolveSymbol(graph, "Missing::normalize"), []);
    assert.deepEqual(resolveSymbol(graph, "Missing::callback.default"), []);
    assert.deepEqual(resolveSymbol(graph, "Acme::Util::normalize", { in: "lib/Acme" }).map((n) => n.id), [id]);
    assert.deepEqual(callersOf(graph, resolveSymbol(graph, id)[0]).map((hit) => hit.node?.id), ["bin/runner.pl#main::run"]);
    assert.deepEqual(edgeWalk(graph, resolveSymbol(graph, "bin/runner.pl#main::run")[0], "out", 2).map((hit) => hit.node?.id), [id]);
  } finally { f.close(); }
});

test("repo maps honor persisted Perl language for shebangs and explicit native-extension overrides", async () => {
  const f = perlRepo({ "bin/runner": "#!/usr/bin/env perl\nsub run {}", "mapped.ts": "package Mapped; sub work {}", "lib/Acme/Util.pm": utilSource, "client.mjs": "export function client() {}" }, { version: 1, files: { "mapped.ts": "perl" } });
  try {
    await f.build(); const graph = f.graph(); const map = buildRepoMap(graph);
    assert.deepEqual(map.totals.languages, ["javascript", "perl"]);
    assert.equal(map.totals.files, graph.nodes.filter((n) => n.kind === "file").length);
    assert.equal(map.totals.symbols, graph.nodes.filter((n) => n.kind !== "file").length);
    assert.ok(map.dirs.some((d) => d.languages.includes("perl")));
    const old = structuredClone(graph); old.nodes = old.nodes.filter((n) => n.path === "client.mjs");
    for (const node of old.nodes) delete node.language;
    assert.deepEqual(buildRepoMap(old).totals.languages, ["javascript"]);
  } finally { f.close(); }
});

test("cards allocate portable distinct paths for Perl extensions and extensionless files", async () => {
  const paths = ["foo.pm", "foo.pl", "foo.t", "foo", "foo.pm.ts", "foo.md/child.pm", "INDEX.pm"];
  const f = perlRepo(Object.fromEntries(paths.map((path, i) => [path, path.endsWith(".ts") ? "export function native() {}" : `#!/usr/bin/env perl\npackage P${i}; sub sentinel_${i} {}`])));
  try {
    await f.build(); const first = writeCards(f.graph(), f.out);
    assert.equal(first.written, paths.length);
    assert.equal(new Set(first.files.map((file) => file.card.toLowerCase())).size, paths.length);
    for (const file of first.files) {
      const card = readFileSync(join(f.out, file.card), "utf8");
      assert.ok(card.startsWith(`# ${file.path}\n`));
      assert.notEqual(file.card.toLowerCase(), "index.md");
      if (!file.path.endsWith(".ts")) assert.match(card, /P\d+::sentinel_\d+/);
      if (file.card !== file.path.replace(/\.[^./]+$/, "") + ".md") assert.ok(readFileSync(join(f.out, "INDEX.md"), "utf8").includes(file.card));
    }
    const bytes = first.files.map((file) => readFileSync(join(f.out, file.card), "utf8"));
    await f.build(); const second = writeCards(f.graph(), f.out);
    assert.deepEqual(second.files, first.files);
    assert.deepEqual(second.files.map((file) => readFileSync(join(f.out, file.card), "utf8")), bytes);
    const removed = first.files.find((file) => file.path === "foo.t")!;
    rmSync(join(f.root, "foo.t")); f.write("renamed.pm", "package Renamed; sub renamed {}");
    await f.build(); const third = writeCards(f.graph(), f.out);
    assert.ok(!existsSync(join(f.out, removed.card)));
    assert.equal(third.written, paths.length);
  } finally { f.close(); }
});

test("cards preserve case-distinct source identities even on case-insensitive output filesystems", async () => {
  const f = perlRepo({ "foo.pm": "package Lower; sub work {}", "upper.pm": "package Upper; sub work {}" });
  try {
    await f.build();
    // A graph created on Linux can later be rendered on Windows/macOS. Simulate
    // that input without requiring two case-distinct files on the test host.
    const graph = f.graph();
    const renamedId = (id: string) => id.replace(/^upper\.pm(?=#|$)/, "Foo.PM");
    for (const node of graph.nodes) {
      node.id = renamedId(node.id);
      if (node.path === "upper.pm") node.path = "Foo.PM";
      if (node.kind === "file" && node.name === "upper.pm") node.name = "Foo.PM";
    }
    for (const edge of graph.edges) { edge.source = renamedId(edge.source); edge.target = renamedId(edge.target); }
    const first = writeCards(graph, f.out);
    assert.equal(first.files.length, 2);
    assert.equal(new Set(first.files.map((file) => file.card.toLowerCase())).size, 2);
    for (const file of first.files) assert.ok(readFileSync(join(f.out, file.card), "utf8").startsWith(`# ${file.path}\n`));
    assert.deepEqual(writeCards(graph, f.out).files, first.files);
  } finally { f.close(); }
});

test("card allocation and pruning preserve concepts, ordinary notes and root concept relocation", async () => {
  const f = perlRepo({ "server.pm": "package Server; sub work {}", "src/concept.pm": "package Concept; sub work {}", "removed.pm": "package Removed; sub gone {}" });
  try {
    mkdirSync(join(f.out, "src"), { recursive: true });
    const rootConcept = "---\nslug: server\nname: Server\nsources: []\n---\nHuman root prose.\n";
    const nestedConcept = "---\nslug: nested\nname: Nested\nsources: []\n---\nHuman nested prose.\n";
    writeFileSync(join(f.out, "server.md"), rootConcept);
    writeFileSync(join(f.out, "src/concept.md"), nestedConcept);
    writeFileSync(join(f.out, "src/notes.md"), "# Notes\n\nKeep these notes.\n");
    writeFileSync(join(f.out, "obsolete.md"), "# obsolete.pm\n\n- gone · function · L1-L1\n");
    await f.build(); const first = writeCards(f.graph(), f.out);
    assert.ok(readFileSync(join(f.out, "server.md"), "utf8").includes("Human root prose."));
    assert.equal(readFileSync(join(f.out, "src/concept.md"), "utf8"), nestedConcept);
    assert.ok(existsSync(join(f.out, "_root/server.md")));
    assert.ok(!existsSync(join(f.out, "obsolete.md")), "previous-format root source cards migrate without an ownership marker");
    const removed = first.files.find((file) => file.path === "removed.pm")!;
    rmSync(join(f.root, "removed.pm")); await f.build();
    assert.ok(!existsSync(join(f.out, removed.card)), "deleted root source cards are pruned");
    assert.equal(readFileSync(join(f.out, "src/notes.md"), "utf8"), "# Notes\n\nKeep these notes.\n");
  } finally { f.close(); }
});

test("deep discovery shares Perl classification, POD, scope filtering and explicit extension behavior", async () => {
  const files = {
    "lib/Acme/Util.pm": "# [[Perl subsystem]]\n" + utilSource,
    "bin/runner": "#!/usr/bin/env perl\n# [[Perl subsystem]]\nsub run {}",
    "t/basic.t": "# [[Perl subsystem]]\nuse Test::More; sub check {}",
    "xt/author": "#!/usr/bin/perl\n# [[Perl subsystem]]\nsub author {}",
    "docs/manual.pod": "=pod\n[[Perl subsystem]]\n=cut\n",
    "foreign.pl": "#!/usr/bin/env python\ndef foreign(): pass\n",
    "extras/query.sql": "-- [[Query subsystem]]\nSELECT 1;",
    "excluded.ts": "export function excluded() {}",
  };
  const f = perlRepo(files, { version: 1, files: { "excluded.ts": "exclude" } });
  try {
    const expected = Object.keys(files).filter((file) => !["foreign.pl", "excluded.ts"].includes(file)).sort();
    const repoPath = (file: string) => relative(f.root, file).split(sep).join("/");
    const selected = listContextFiles(f.root, f.out, CODE_EXTENSIONS).map(repoPath).sort();
    assert.deepEqual(selected, expected);
    assert.deepEqual(listContextFiles(f.root, f.out, [".sql"]).map(repoPath), ["extras/query.sql"]);
    assert.deepEqual(listContextFiles(f.root, f.out, CODE_EXTENSIONS, ["lib"]).map(repoPath), ["lib/Acme/Util.pm"]);
    const result = await buildContext(f.root, { contextDir: f.out, model: "fake", ...fakeProviders() });
    assert.equal(result.failedFiles, 0); assert.equal(result.files, expected.length);
    assert.deepEqual(readManifest(f.out)!.files.map((file) => file.path).sort(), expected);
    await f.build();
    const conceptPath = join(f.out, "perl-subsystem.md");
    const concept = readFileSync(conceptPath, "utf8");
    const covers = matter(concept).data.covers;
    assert.ok(covers.some((entry: { symbol: string; at: string }) => entry.symbol === "Acme::Util::normalize" && entry.at === "lib/Acme/Util.pm:L7-L10"));
    await f.build(); assert.equal(readFileSync(conceptPath, "utf8"), concept);
    assert.equal(checkContext(f.root, { contextDir: f.out }).ok, true);
    f.write("bin/runner", files["bin/runner"] + "\nsub changed {}\n");
    const stale = checkContext(f.root, { contextDir: f.out });
    assert.deepEqual(stale.contentDrift.map((file) => file.path), ["bin/runner"]);
  } finally { f.close(); }
});

test("relocated card links escape Markdown labels and URL path characters", async () => {
  const f = perlRepo({ "odd/name [copy] (1).pm": "package Module; sub work {}", "odd/name [copy] (1).pl": "package Script; sub run {}" });
  try {
    await f.build(); const cards = writeCards(f.graph(), f.out);
    assert.equal(cards.written, 2);
    const index = readFileSync(join(f.out, "INDEX.md"), "utf8");
    for (const file of cards.files) {
      const link = file.card.replaceAll(" ", "%20").replaceAll("[", "%5B").replaceAll("]", "%5D").replaceAll("(", "%28").replaceAll(")", "%29");
      assert.ok(index.includes(`](${link})`)); assert.ok(index.includes("name \\[copy\\] (1)"));
      assert.ok(existsSync(join(f.out, decodeURIComponent(link))));
    }
  } finally { f.close(); }
});
