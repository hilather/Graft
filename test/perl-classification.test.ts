import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifySource, hasPerlShebang, SOURCE_PREFIX_BYTES } from "../src/graph/source-classify.js";
import { parsePerlConfig, perlProjectOf, PerlConfigError } from "../src/graph/perl-config.js";
import { readSourcePrefix } from "../src/util/source.js";

test("Perl classification has exact interpreter identity, including env -S and versioned perl", () => {
  for (const line of ["#!/usr/bin/perl", "#!/usr/bin/perl5.40.0 -w", "#!/usr/bin/env perl\r\n", "#!/usr/bin/env -S perl -w", "#!/usr/bin/env -S 'perl -w'", "#!/usr/bin/env --split-string='perl -w'", "#!/usr/bin/env -i -u FOO BAR=value perl"]) {
    assert.equal(hasPerlShebang(line), true, line);
    assert.equal(classifySource("bin/tool", line)?.language, "perl", line);
  }
  for (const line of ["#!/bin/echo perl", "#!/usr/bin/perldoc", "#!/usr/bin/perlbrew", "#!/usr/bin/perl6", "#!/usr/bin/env raku", "#!/bin/sh\n# perl", "#!/usr/bin/env FOO=perl sh", "#!/usr/bin/env -S 'perl", "# perl\n#!/usr/bin/perl", "#!/usr/bin/env " + "-S ".repeat(200)]) {
    assert.equal(hasPerlShebang(line), false, line);
    assert.equal(classifySource("bin/tool", line), null, line);
  }
});

test("Perl candidates require the promised filename, tokens or owning project", () => {
  for (const file of ["lib/A.pm", "app.psgi", "Makefile.PL", "Build.PL", "cpanfile"]) assert.equal(classifySource(file, "")?.language, "perl", file);
  for (const code of ["package Acme::Util;", "use strict;", "use Test::More;", "my sub inner {}", "state sub memo {}", "sub foo {}", "my $n = 1;", "# comment\n=pod\nsub fake {}\n=cut\npackage Real;"]) {
    for (const file of ["standalone.pl", "generator.PL", "t/basic.t"]) assert.equal(classifySource(file, code)?.language, "perl", `${file}: ${code}`);
  }
  for (const code of ["foo();", "# sub fake {}", "=pod\npackage Fake;", "q{sub fake {}};", "'use strict;';", "<<'END';\npackage Fake;\nEND", "__DATA__\nsub fake {}", "foo(a).", "foo(X) :- bar(X).", "  $ echo example", "package require Tcl"]) {
    assert.equal(classifySource("standalone.pl", code), null, code);
    assert.equal(classifySource("t/basic.t", code), null, code);
  }
  assert.equal(classifySource("handler.cgi", "use strict;"), null);
  assert.equal(classifySource("handler.cgi", "#!/usr/bin/env perl")?.language, "perl");
  assert.equal(classifySource("doc.pod", "sub fake {}")?.kind, "perl");
  assert.equal((classifySource("doc.pod", "sub fake {}") as { mode: string }).mode, "pod");
  assert.equal(classifySource("file.raku", "#!/usr/bin/perl"), null);
  assert.equal(classifySource("file.xs", "package Fake;"), null);
});

test("classification priority preserves native languages, foreign shebangs and explicit rules", () => {
  assert.equal(classifySource("file.pm", "#!/bin/sh\necho hello"), null);
  assert.equal(classifySource("file.ts", "#!/usr/bin/perl")?.language, "typescript");
  assert.equal(classifySource("file.js", "")?.language, "javascript");
  assert.equal(classifySource("file.vue", "")?.kind, "container");
  assert.equal(classifySource("file.rs", "")?.kind, "generic");
  assert.equal(classifySource("file.pm", "sub real {}", { rule: "exclude" }), null);
  assert.equal(classifySource("legacy", "foo();", { rule: "perl" })?.language, "perl");
  assert.equal(classifySource("file.pm", "\0binary"), null);
  assert.equal(classifySource("blib/lib/A.pm", "package A;"), null);
  assert.equal(classifySource("blib/lib/A.pm", "package A;", { rule: "perl" })?.language, "perl");
  assert.equal(classifySource("blib/lib/A.pm", "", { includeGenerated: true })?.language, "perl");
  assert.equal(classifySource("local/src/real.ts", "")?.language, "typescript");
  assert.equal(classifySource("blib/src/real.ts", "")?.language, "typescript");
});

test("distribution hints stay separate from unrelated sibling projects and ranking guards", () => {
  const config = parsePerlConfig(null, ["a/cpanfile", "a/t/plain.t", "b/t/plain.t", "a/nested/Makefile.PL"]);
  assert.deepEqual(config.projects.map((p) => p.root), ["a/nested", "a"]);
  for (const [file, expected] of [["a/t/plain.t", "perl"], ["a/xt/plain.t", "perl"], ["a/other/plain.t", undefined], ["a/plain.pl", "perl"], ["b/t/plain.t", undefined], ["a/nested/t/plain.t", "perl"]] as const) {
    assert.equal(classifySource(file, "foo();", { project: perlProjectOf(file, config) })?.language, expected, file);
  }
  assert.equal(classifySource("a/t/foreign.t", "package require Tcl", { project: config.projects[1] }), null);
  assert.equal(classifySource("a/prolog.pl", "foo(X) :- bar(X).", { project: config.projects[1] }), null);
});

test("config validates paths and preserves ordered graph-relative roots and unknown CWD", () => {
  const config = parsePerlConfig(JSON.stringify({ version: 1, projects: [{ root: "services/billing", includeRoots: ["shared/lib", "services/billing/lib"], analysisCwd: "." }], files: { "tools/legacy": "perl" } }), ["services/billing/cpanfile"]);
  assert.deepEqual(config.projects[0], { root: "services/billing", includeRoots: ["shared/lib", "services/billing/lib"], analysisCwd: "", confidence: "extracted", markers: ["cpanfile"] });
  assert.equal(config.files["tools/legacy"], "perl");
  assert.equal(parsePerlConfig(null, ["cpanfile"]).projects[0].analysisCwd, undefined);
  assert.notEqual(config.identity, parsePerlConfig(null, ["services/billing/cpanfile"]).identity);
  assert.notEqual(parsePerlConfig(null, []).identity, parsePerlConfig(null, ["cpanfile"]).identity);
  for (const text of [
    "{", '{"version":2}', '{"version":1,"extra":true}', '{"version":1,"files":{"a":"perl","a":"exclude"}}',
    '{"version":1,"files":{"a":"perl","\\u0061":"exclude"}}', '{"version":1,"files":{"a":"perl","./a":"exclude"}}',
    '{"version":1,"files":{"x":"python"}}', '{"version":1,"files":{"../x":"perl"}}',
    ...["/absolute", "C:/absolute", "../escape", "lib/**", "lib\\win"].map((root) => JSON.stringify({ version: 1, projects: [{ root, includeRoots: [] }] })),
    JSON.stringify({ version: 1, projects: [{ root: ".", includeRoots: ["lib", "./lib"] }] }),
    JSON.stringify({ version: 1, projects: [{ root: ".", includeRoots: [] }, { root: "./", includeRoots: [] }] }),
  ]) assert.throws(() => parsePerlConfig(text, []), PerlConfigError, text);
});

test("bounded prefix reads use source decoding for UTF-16LE and reject UTF-16BE", () => {
  const root = mkdtempSync(join(tmpdir(), "graft-perl-prefix-"));
  try {
    const file = join(root, "script");
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("#!/usr/bin/perl\r\n" + "x".repeat(10_000), "utf16le")]));
    const prefix = readSourcePrefix(file, SOURCE_PREFIX_BYTES)!;
    assert.ok(prefix.length <= SOURCE_PREFIX_BYTES / 2);
    assert.equal(hasPerlShebang(prefix), true);
    writeFileSync(file, Buffer.from([0xfe, 0xff, 0, 35]));
    assert.equal(readSourcePrefix(file, SOURCE_PREFIX_BYTES), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
