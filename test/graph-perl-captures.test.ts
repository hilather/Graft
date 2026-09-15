import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

const diagnostics = (f: ReturnType<typeof perlRepo>) => JSON.parse(readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8")).files;

test("saved CODE values and replacement closures have distinct call targets", async () => {
  const f = perlRepo({ "wrapper.pl": String.raw`package P;
sub target {}
my $previous = \&target;
{
  no warnings 'redefine';
  *target = sub { goto &$previous };
}
target();
$previous->();
` });
  try {
    await f.build();
    const graph = f.graph(), wrapper = graph.nodes.find(node => node.name === "*target")!;
    assert.ok(wrapper, "the installed closure needs its own graph identity");
    assert.deepEqual(semanticEdges(graph), [
      `wrapper.pl -> ${wrapper.id} [extracted]`,
      "wrapper.pl -> wrapper.pl#P::target [extracted]",
      `${wrapper.id} -> wrapper.pl#P::target [extracted]`,
    ].sort());
    assert.deepEqual(diagnostics(f)["wrapper.pl"].diagnostics, []);
    const cold = f.bytes();
    assert.equal((await f.build()).parsed, 0);
    assert.equal(f.bytes(), cold);
  } finally { f.close(); }
});

test("saved references resolve within a routine and in callbacks created after capture", async () => {
  for (const source of [
    String.raw`package P; sub target {} sub run { my $saved = \&target; $saved->() } run();`,
    String.raw`package P; sub target {} my $saved = \&target; my $run = sub { $saved->() }; $run->();`,
    String.raw`package P; sub target {} my $saved = \&target; sub run { $saved->() } run();`,
    String.raw`package P; sub target {} *alias = \&target; my $saved = \&alias; *target = sub {}; $saved->();`,
    String.raw`package P; use feature 'lexical_subs'; my sub target {} my $saved = \&target; $saved->();`,
  ]) {
    const f = perlRepo({ "capture.pl": source });
    try {
      await f.build();
      assert.ok(semanticEdges(f.graph()).some(edge => / -> capture\.pl#P::target(?:@[^ ]+)? \[/.test(edge)), source);
      assert.ok(!JSON.stringify(diagnostics(f)).includes("Cannot establish one source target for $saved"), source);
    } finally { f.close(); }
  }
});

test("captures are not proven across reassignment, escape, eval, or skipped initialization", async () => {
  for (const source of [
    String.raw`package P; sub target {} sub other {} my $saved = \&target; $saved = \&other; $saved->();`,
    String.raw`package P; sub target {} sub other {} my $saved = \&target; my $run = sub { $saved->() }; $saved = \&other; $run->();`,
    String.raw`package P; sub target {} my $saved = \&target; change(\$saved); $saved->();`,
    String.raw`package P; sub target {} my $saved = \&target; my $run = sub { $saved->() }; change(\$saved); $run->();`,
    String.raw`package P; sub target {} my $saved = \&target; eval $code; $saved->();`,
    String.raw`package P; sub target {} my $saved = \&target; my $run = sub { $saved->() }; eval $code; $run->();`,
    String.raw`package P; sub target {} my $saved = \&target if $flag; $saved->();`,
    String.raw`package P; sub target {} run(); my $saved = \&target; sub run { $saved->() }`,
    String.raw`package P; sub target {} my $saved = \&missing; $saved->();`,
    String.raw`package P; sub target {} state $saved = \&target; $saved->();`,
  ]) {
    const f = perlRepo({ "capture.pl": source });
    try {
      await f.build();
      assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes(" -> capture.pl#P::target ")), source);
      assert.ok(JSON.stringify(diagnostics(f)).includes("Cannot establish one source target for $saved"), source);
    } finally { f.close(); }
  }
});

test("module initialization may call a named routine before its capture exists", async () => {
  const f = perlRepo({
    "main.pl": String.raw`package P; sub target {} use Trigger (); my $saved = \&target; sub run { $saved->() }`,
    "lib/Trigger.pm": "package Trigger; P::run(); 1;",
  });
  try {
    await f.build();
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.startsWith("main.pl#P::run ->")));
  } finally { f.close(); }
});

test("a captured callee receives invocation-time symbol mutations through aliases", async () => {
  const f = perlRepo({ "capture.pl": String.raw`package P;
sub victim {}
sub target { victim() }
*alias = \&target;
my $saved = \&alias;
*victim = sub {};
$saved->();
` });
  try {
    await f.build();
    assert.ok(!semanticEdges(f.graph()).includes("capture.pl#P::target -> capture.pl#P::victim [extracted]"));
    assert.ok(semanticEdges(f.graph()).includes("capture.pl -> capture.pl#P::target [extracted]"));
  } finally { f.close(); }
});

test("imported captures propagate caller mutations into their source bodies", async () => {
  const f = perlRepo({
    "lib/P.pm": "package P; use Exporter 'import'; our @EXPORT_OK = qw(target); sub target { Q::victim() } 1;",
    "main.pl": String.raw`package Q; use P qw(target); sub victim {} my $saved = \&target; *victim = sub {}; $saved->();`,
  });
  try {
    await f.build();
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.startsWith("lib/P.pm#P::target -> main.pl#Q::victim ")));
    assert.ok(semanticEdges(f.graph()).some(edge => edge.startsWith("main.pl -> lib/P.pm#P::target ")));
  } finally { f.close(); }
});

test("calls through installed closures propagate their mutations", async () => {
  const f = perlRepo({ "wrapper.pl": String.raw`package P;
sub victim {}
*wrapper = sub { *victim = sub {} };
wrapper(); victim();
` });
  try {
    await f.build();
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes(" -> wrapper.pl#P::victim ")));
  } finally { f.close(); }
});

test("multiple replacements of one slot keep separate closure identities", async () => {
  const f = perlRepo({ "wrapper.pl": String.raw`package P;
sub first {} sub second {}
*wrapper = sub { first() };
*wrapper = sub { second() };
wrapper();
` });
  try {
    await f.build();
    const wrappers = f.graph().nodes.filter(node => node.name === "*wrapper");
    assert.equal(wrappers.length, 2);
    assert.equal(new Set(wrappers.map(node => node.id)).size, 2);
  } finally { f.close(); }
});
