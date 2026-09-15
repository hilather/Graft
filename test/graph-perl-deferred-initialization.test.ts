import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

const main = "sub load_helper { require Helper } load_helper(); require Good; Good::run();";
const good = "package Good; sub run {} 1;";
const reachesGood = (f: ReturnType<typeof perlRepo>) => semanticEdges(f.graph()).some(edge => edge === "main.pl -> lib/Good.pm#Good::run [extracted]");
const diagnostics = (f: ReturnType<typeof perlRepo>) => JSON.parse(readFileSync(join(f.out, ".cache/perl-diagnostics.json"), "utf8")).files;

test("requiring a module through a routine does not invoke its unused mutators", async () => {
  const helper = "package Helper; sub unused { delete $INC{'Good.pm'}; chdir 'extra'; @INC = (); } 1;";
  const f = perlRepo({ "main.pl": main, "lib/Helper.pm": helper, "lib/Good.pm": good });
  try {
    await f.build();
    assert.ok(reachesGood(f));
    assert.deepEqual(diagnostics(f)["main.pl"].diagnostics, []);
    const cold = f.bytes();
    assert.equal((await f.build()).parsed, 0);
    assert.equal(f.bytes(), cold);
    f.write("lib/Helper.pm", helper.replace("1;", "unused(); 1;"));
    assert.equal((await f.build()).parsed, 1);
    assert.ok(!reachesGood(f));
    assert.ok(JSON.stringify(diagnostics(f)["main.pl"]).includes("PERL_MODULE_UNRESOLVED"));
  } finally { f.close(); }
});

test("nested uses invoke only the requested source import hook", async () => {
  for (const [load, expected] of [["use Hook;", false], ["no Hook;", false], ["use Hook ();", true], ["no Hook ();", true], ["require Hook;", true]] as const) {
    const f = perlRepo({ "main.pl": main, "lib/Helper.pm": `package Helper; ${load} 1;`,
      "lib/Hook.pm": "package Hook; sub import { delete $INC{'Good.pm'} } sub unimport { chdir 'elsewhere' } 1;", "lib/Good.pm": good });
    try {
      await f.build();
      assert.equal(reachesGood(f), expected, load);
    } finally { f.close(); }
  }
});

test("initializer calls and callbacks still activate deferred load effects", async () => {
  for (const initializer of ["configure();", "sub init { configure() } init();", "my $cb = sub { configure() }; $cb->();", String.raw`my $cb = \&configure; $cb->();`, "configure() if $flag;", "sub AUTOLOAD { configure() } missing();"]) {
    const f = perlRepo({ "main.pl": main, "lib/Helper.pm": `package Helper; sub configure { delete $INC{'Good.pm'} } ${initializer} 1;`, "lib/Good.pm": good });
    try { await f.build(); assert.ok(!reachesGood(f), initializer); }
    finally { f.close(); }
  }
});

test("nested imports follow inherited and aliased source hook bodies", async () => {
  for (const hook of ["package Hook; use parent 'Base'; 1;", String.raw`package Hook; sub configure { delete $INC{'Good.pm'} } *import = \&configure; 1;`, "package Hook; *import = sub { delete $INC{'Good.pm'} }; 1;"]) {
    const f = perlRepo({ "main.pl": main, "lib/Helper.pm": "package Helper; use Hook; 1;", "lib/Hook.pm": hook,
      "lib/Base.pm": "package Base; sub import { delete $INC{'Good.pm'} } 1;", "lib/Good.pm": good });
    try { await f.build(); assert.ok(!reachesGood(f), hook); }
    finally { f.close(); }
  }
});

test("computed loads in the newly initialized module keep later load identity unknown", async () => {
  const f = perlRepo({ "main.pl": main, "lib/Helper.pm": "package Helper; require $runtime_module; 1;", "lib/Good.pm": good });
  try {
    await f.build();
    assert.ok(!reachesGood(f));
    assert.ok(JSON.stringify(diagnostics(f)["main.pl"]).includes("PERL_MODULE_UNRESOLVED"));
  } finally { f.close(); }
});

test("mapped runtime file loads carry initializer and lifecycle effects", async () => {
  for (const [helper, compile, expected] of [
    ["package Helper; sub unused { delete $INC{'Good.pm'} } 1;", false, true],
    ["package Helper; delete $INC{'Good.pm'}; 1;", false, false],
    ["package Helper; INIT { delete $INC{'Good.pm'} } 1;", true, false],
  ] as const) {
    const f = perlRepo({ "main.pl": `sub load_helper { require '/rt/runtime/Helper.pm' } ${compile ? 'BEGIN { load_helper() }' : 'load_helper();'} require Good; Good::run();`,
      "lib/Helper.pm": helper, "lib/Good.pm": good }, { version: 1, projects: [{ root: ".", analysisCwd: ".", includeRoots: ["lib"], pathMappings: { "/rt/runtime": "lib" } }] });
    try { await f.build(); assert.equal(reachesGood(f), expected, helper); }
    finally { f.close(); }
  }
});

test("deferred module loads distinguish compile lifecycle from runtime require", async () => {
  for (const phase of ["BEGIN", "UNITCHECK", "CHECK", "INIT", "END"]) for (const compile of [false, true]) {
    const f = perlRepo({ "main.pl": compile ? "sub load_helper { require Helper } BEGIN { load_helper() } require Good; Good::run();" : main,
      "lib/Helper.pm": `package Helper; ${phase} { delete $INC{'Good.pm'} } 1;`, "lib/Good.pm": good });
    try {
      await f.build();
      const active = ["BEGIN", "UNITCHECK"].includes(phase) || compile && ["CHECK", "INIT"].includes(phase);
      assert.equal(reachesGood(f), !active, `${phase}, compile=${compile}`);
    } finally { f.close(); }
  }
});
