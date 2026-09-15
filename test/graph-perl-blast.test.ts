import { test } from "node:test";
import assert from "node:assert/strict";
import { perlRepo, runnerSource, utilSource } from "./helpers/perl-repo.js";
import { initPerlGit, perlCli, perlGit } from "./helpers/perl-cli.js";
import { isTestPath, ask } from "../src/ask/ask.js";
import type { BlastReport } from "../src/blast/blast.js";

test("Perl test/support classification uses language identity, directory segments and .t suffixes", () => {
  for (const path of ["t/basic.t", "xt/author.t", "t/runner", "xt/lib/Helper.pm", "services/a/t/check", "checks/smoke.t"]) assert.equal(isTestPath(path, "perl"), true, path);
  for (const path of ["lib/Test.pm", "lib/next.pm", "scripts/start", "project/thing.pm"]) assert.equal(isTestPath(path, "perl"), false, path);
  for (const language of [undefined, "typescript", "prolog"]) for (const path of ["t/thing.ts", "xt/helper.pm", "logic.t"]) assert.equal(isTestPath(path, language), false, `${path}:${language}`);
});

test("Perl blast reads real Git hunks and separates reaching t/xt/support files from application callers", async () => {
  const testSource = "use Acme::Util qw(normalize);\nsub exercise {\n  normalize('X');\n}\n";
  const tests = ["t/basic.t", "xt/author.t", "t/lib/Helper.pm", "xt/runner", "checks/smoke.t"];
  const f = perlRepo({ "lib/Acme/Util.pm": utilSource, "bin/runner.pl": runnerSource, "lib/Other.pm": "package Other; sub normalize {}", ...Object.fromEntries(tests.map((path) => [path, path === "xt/runner" ? "#!/usr/bin/perl\n" + testSource : testSource])) });
  try {
    initPerlGit(f.root); perlGit(f.root, "config", "diff.mnemonicPrefix", "true");
    await f.build(); perlGit(f.root, "add", "-A"); perlGit(f.root, "commit", "-m", "source baseline");
    f.write("lib/Acme/Util.pm", utilSource.replace("return lc $value", "return uc $value"));
    const run = () => {
      const result = perlCli(f, ["blast", f.root, "--format", "json", "--no-owners"]);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout) as BlastReport;
    };
    const stale = run();
    assert.deepEqual(stale.changed.map((file) => file.path), ["lib/Acme/Util.pm"]);
    assert.deepEqual(stale.seeds.map((seed) => seed.id), ["lib/Acme/Util.pm#Acme::Util::normalize"], JSON.stringify(stale.changed));
    assert.ok(stale.impacted.some((hit) => hit.id === "bin/runner.pl#main::run"));
    assert.ok(!stale.impacted.some((hit) => hit.path === "lib/Other.pm"));
    assert.deepEqual(stale.modules.flatMap((module) => module.files).sort(), ["bin/runner.pl"]);
    assert.deepEqual(stale.testModules.flatMap((module) => module.files).sort(), [...tests].sort());
    assert.equal(stale.areas[0].tests, "stale");
    assert.deepEqual(stale.areas[0].testFiles, [...tests].sort());
    assert.equal(stale.areas[0].reached, 1);
    f.write("t/basic.t", testSource.replace("'X'", "'Y'"));
    const changed = run();
    const area = changed.areas.find((area) => area.files.includes("lib/Acme/Util.pm"))!;
    assert.equal(area.tests, "changed"); assert.deepEqual(area.changedTestFiles, ["t/basic.t"]);
    assert.ok(!changed.areas.some((area) => area.files.includes("t/basic.t")));
  } finally { f.close(); }
});

test("ordinary Perl lookup favors an implementation over matching test support", async () => {
  const f = perlRepo({ "lib/Implementation.pm": "package Implementation; sub normalize { return 'token_normalizer_420' }", "t/support.pm": "package Support; sub normalize { return 'token_normalizer_420' }" });
  try {
    await f.build();
    const result = ask(f.root, "normalize token_normalizer_420", { contextDir: f.out, graphRank: false });
    assert.match(result.hits[0].pointer, /^lib\/Implementation\.pm(?::|$)/);
  } finally { f.close(); }
});
