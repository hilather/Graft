/** Compare a source-reviewed oracle with a pinned corpus. Never executes Perl. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  corpus: { type: "string" }, "oracle-dir": { type: "string" }, output: { type: "string" },
  package: { type: "string" }, "keep-work": { type: "boolean", default: false },
  "existing-work": { type: "string" },
} });
assert.ok(values.corpus && values["oracle-dir"] && values.output,
  "Usage: node scripts/review-perl-corpus.mjs --corpus DIR --oracle-dir DIR --output FILE [--package DIR] [--keep-work]");
const corpus = resolve(values.corpus), oracleDir = resolve(values["oracle-dir"]), output = resolve(values.output);
const packageDir = resolve(values.package ?? fileURLToPath(new URL("../", import.meta.url)));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const outside = path => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
assert.ok(outside(relative(corpus, output)), "Output must be outside the immutable corpus");
const input = path => {
  assert.ok(path && !outside(relative(corpus, resolve(corpus, path))), `Invalid corpus path: ${path}`);
  return readFileSync(join(corpus, path));
};
const manifestBytes = input("graft-benchmark-corpus.json"), manifest = JSON.parse(manifestBytes);
const definitionBytes = readFileSync(join(oracleDir, "semantic-definitions.json"));
const callBytes = readFileSync(join(oracleDir, "semantic-calls.json"));
const definitions = JSON.parse(definitionBytes), calls = JSON.parse(callBytes);
for (const oracle of [definitions, calls]) assert.equal(oracle.corpusManifestSha256, hash(manifestBytes));
const sources = new Map();
for (const file of manifest.files) {
  const bytes = input(file.path);
  assert.equal(bytes.length, file.bytes, file.path); assert.equal(hash(bytes), file.sha256, file.path);
  sources.set(file.path, bytes.toString("utf8"));
}
for (const file of [...definitions.files, ...calls.providerFiles]) assert.equal(hash(input(file.path)), file.sha256, file.path);
assert.equal(hash(input("graft.perl.json")), manifest.configSha256);
const selected = new Set(definitions.files.map(file => file.path));
assert.deepEqual([...selected].sort(), [...calls.reviewedCallFiles].sort());
const importModule = name => import(pathToFileURL(join(packageDir, "dist/graph", `${name}.js`)).href);
const [{ buildGraph }, { readExtractCache }, { parsePerlConfig }, { buildPerlModuleEnvironment },
  { materializePerlFrameworks }, { resolvePerlEdges }] = await Promise.all([
  "build", "extract-cache", "perl-config", "perl-modules", "perl-frameworks", "perl-resolve",
].map(importModule));
const distHash = createHash("sha256");
function stamp(dir, prefix = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = join(dir, entry.name), name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) stamp(path, `${name}/`);
    else if (entry.isFile()) distHash.update(name).update("\0").update(hash(readFileSync(path))).update("\n");
  }
}
stamp(join(packageDir, "dist"));
const scratch = values["existing-work"] ? resolve(values["existing-work"]) : mkdtempSync(join(tmpdir(), "graft-perl-review-"));
try {
  if (!values["existing-work"]) {
    for (const file of manifest.files) {
      const path = join(scratch, file.path); mkdirSync(dirname(path), { recursive: true });
      copyFileSync(join(corpus, file.path), path);
    }
    copyFileSync(join(corpus, "graft.perl.json"), join(scratch, "graft.perl.json"));
  } else {
    for (const file of manifest.files) assert.equal(hash(readFileSync(join(scratch, file.path))), file.sha256);
    assert.equal(hash(readFileSync(join(scratch, "graft.perl.json"))), manifest.configSha256);
  }
  const contextDir = join(scratch, "graft");
  console.error(`[perl-review] Building ${manifest.files.length} pinned files in ${scratch}`);
  const build = values["existing-work"]
    ? { fromRetainedBuild: true, graphPath: join(contextDir, ".graph", "wiring.json") }
    : await buildGraph(scratch, { contextDir, reuse: false });
  console.error("[perl-review] Build complete; reconstructing semantic context");
  const graphBytes = readFileSync(build.graphPath), graph = JSON.parse(graphBytes);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const cache = readExtractCache(contextDir);
  const facts = new Map(Object.entries(cache.files).filter(([, entry]) => entry.languageData).map(([path, entry]) => [path, entry.languageData]));
  assert.deepEqual(graph.nodes.filter(node => node.kind === "file").map(node => node.path).sort(), [...sources.keys()].sort());
  assert.equal(facts.size, sources.size, "Every selected corpus file must have cached Perl facts");
  // Source discovery caches decoded UTF-8 text. Raw archive bytes above retain
  // a separate identity, including legacy-encoded comments in the corpus.
  for (const file of manifest.files) assert.equal(cache.files[file.path].hash, hash(sources.get(file.path)));
  const failedParses = Object.entries(cache.files).filter(([, entry]) => entry.status === "failed")
    .map(([path, entry]) => ({ path, diagnostics: entry.languageData.diagnostics }));
  const config = parsePerlConfig(input("graft.perl.json").toString("utf8"), [...facts.keys()]);
  const environment = buildPerlModuleEnvironment(facts, config, scratch);
  const frameworks = materializePerlFrameworks(facts, environment);

  // Graph edges deduplicate caller/target pairs. Give every extracted call a
  // distinct output-only source ID while preserving its original context,
  // scopes, bindings, load environment and all provider facts. Collapsing those
  // IDs must reproduce the actual graph before any site-level result is trusted.
  const instrumentedNodes = [...graph.nodes], actualSites = [], instrumentedFiles = new Map();
  for (const [path, file] of frameworks.files) {
    const fileCalls = selected.has(path) ? file.calls.map(call => {
      const source = byId.get(call.sourceNode); assert.ok(source, call.sourceNode);
      const id = `review-call:${actualSites.length}`; assert.ok(!byId.has(id));
      instrumentedNodes.push({ ...source, id });
      actualSites.push({ id, path, call });
      return { ...call, sourceNode: id };
    }) : file.calls;
    // Nonselected calls and references remain semantic context for incoming
    // effects, callbacks and import snapshots. Only output ownership changes.
    instrumentedFiles.set(path, { ...file, calls: fileCalls });
  }
  console.error("[perl-review] Resolving instrumented calls with complete context");
  const resolution = resolvePerlEdges(instrumentedNodes, instrumentedFiles, environment);
  console.error("[perl-review] Checking graph parity and frozen oracle");
  const edgesBySite = new Map();
  for (const edge of resolution.edges.filter(edge => edge.relation === "calls")) {
    const list = edgesBySite.get(edge.source) ?? []; list.push(edge); edgesBySite.set(edge.source, list);
  }
  const collapse = new Set(actualSites.flatMap(site => (edgesBySite.get(site.id) ?? []).map(edge => `${site.call.sourceNode}\0${edge.target}`)));
  const actualGraphCalls = new Set(graph.edges.filter(edge => edge.relation === "calls" && selected.has(byId.get(edge.source)?.path)).map(edge => `${edge.source}\0${edge.target}`));
  assert.deepEqual([...collapse].sort(), [...actualGraphCalls].sort(), "Per-site instrumentation changed actual graph bindings");

  const definitionResults = definitions.definitions.map(expected => {
    const found = graph.nodes.filter(node => node.path === expected.path && node.qualified_name === `${expected.package}::${expected.name}`);
    const exact = found.filter(node => node.span === `L${expected.startLine}-L${expected.endLine}`);
    return { ...expected, found: found.map(node => ({ id: node.id, span: node.span, kind: node.kind })), exact: exact.length === 1 };
  });
  const additionalConstants = definitions.additionalSourceConstants.map(expected => ({
    ...expected, found: graph.nodes.filter(node => node.path === expected.path && node.kind === "constant" && node.qualified_name === `${expected.package}::${expected.name}`).map(node => ({ id: node.id, span: node.span })),
  }));
  const additionalPackages = definitions.additionalPackages.map(expected => ({
    ...expected, found: graph.nodes.filter(node => node.path === expected.path && node.qualified_name === expected.name).map(node => ({ id: node.id, span: node.span, kind: node.kind })),
  }));
  const used = new Set();
  const callResults = calls.sites.map(expected => {
    const lines = sources.get(expected.path).split("\n");
    // Oracle columns count source characters. Tree-sitter facts use UTF-16.
    const before = lines.slice(0, expected.line - 1).join("\n");
    const prefix = [...lines[expected.line - 1]].slice(0, expected.column - 1).join("");
    const start = before.length + (expected.line > 1 ? 1 : 0) + prefix.length;
    assert.equal(sources.get(expected.path).slice(start, start + expected.token.length), expected.token);
    const matches = actualSites.filter(site => site.path === expected.path && site.call.range.start <= start && site.call.range.end >= start + expected.token.length
      && (site.call.name.kind === "unknown" ? site.call.range.start === start : site.call.name.value.replace(/^&/, "") === expected.token));
    matches.sort((a, b) => a.call.range.end - a.call.range.start - (b.call.range.end - b.call.range.start));
    const actual = matches[0];
    if (actual) { assert.ok(!used.has(actual.id), `Two oracle sites matched ${actual.id}`); used.add(actual.id); }
    const predictions = (actual ? edgesBySite.get(actual.id) ?? [] : []).map(edge => {
      const node = byId.get(edge.target); assert.ok(node);
      return { id: node.id, path: node.path, qualifiedName: node.qualified_name, span: node.span, confidence: edge.confidence };
    });
    const correct = expected.category === "supported" && predictions.length === 1
      && predictions[0].path === expected.target.path && predictions[0].qualifiedName === expected.target.qualifiedName
      && predictions[0].span.startsWith(`L${expected.target.startLine}-`);
    return { ...expected, fact: actual ? { id: actual.id, sourceNode: actual.call.sourceNode, range: actual.call.range, name: actual.call.name, form: actual.call.form, syntax: actual.call.syntax } : null, predictions, correct };
  });
  const unmatchedResolvedCalls = actualSites.filter(site => !used.has(site.id) && edgesBySite.has(site.id)).map(site => ({ ...site, edges: edgesBySite.get(site.id) }));
  const supported = callResults.filter(site => site.category === "supported");
  const correctCalls = supported.filter(site => site.correct).length;
  const predictedCalls = callResults.reduce((sum, site) => sum + site.predictions.length, 0) + unmatchedResolvedCalls.reduce((sum, site) => sum + site.edges.length, 0);
  const summary = {
    namedDefinitions: definitionResults.length, exactDefinitions: definitionResults.filter(item => item.exact).length,
    definitionRecall: definitionResults.filter(item => item.exact).length / definitionResults.length,
    sourceConstants: additionalConstants.length, foundConstants: additionalConstants.filter(item => item.found.length === 1).length,
    sourcePackages: additionalPackages.length, foundPackages: additionalPackages.filter(item => item.found.length === 1).length,
    reviewedCalls: callResults.length, supportedCalls: supported.length, correctCalls, predictedCalls,
    callRecall: correctCalls / supported.length, callPrecision: predictedCalls ? correctCalls / predictedCalls : null,
    categories: Object.fromEntries([...new Set(callResults.map(site => site.category))].map(category => [category, callResults.filter(site => site.category === category).length])),
    unmatchedResolvedCalls: unmatchedResolvedCalls.length, instrumentationMatchesActualGraph: true,
    failedParses: failedParses.length,
  };
  const report = {
    version: 1, at: new Date().toISOString(), node: process.version, packageDir, compiledDistSha256: distHash.digest("hex"),
    driverSha256: hash(readFileSync(fileURLToPath(import.meta.url))), corpusManifestSha256: hash(manifestBytes),
    definitionOracleSha256: hash(definitionBytes), callOracleSha256: hash(callBytes), graphSha256: hash(graphBytes),
    method: `${values["existing-work"] ? "Retained full-corpus build; source/cache hashes revalidated; no reparsing." : "Fresh full-corpus build."} Source-reviewed oracle predates comparison. Distinct output-only source IDs preserve all binding context and reproduce the actual deduplicated graph. Match each oracle callee token to the smallest enclosing same-name fact; absent facts are misses. Unmatched resolved sites count against precision pending source audit. Exact named-definition spans are required. Builtins/external/ambiguous/unsupported sites are excluded only from supported-call recall. Parse failures remain separate blockers.`,
    ...(values["keep-work"] || values["existing-work"] ? { scratch } : {}), summary, build, failedParses, definitionResults, additionalConstants, additionalPackages, callResults, unmatchedResolvedCalls,
  };
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, ...summary }, null, 2));
} finally { if (!values["keep-work"] && !values["existing-work"]) rmSync(scratch, { recursive: true, force: true }); }
