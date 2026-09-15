import { test } from "node:test";
import assert from "node:assert/strict";
import { perlRepo, semanticEdges } from "./helpers/perl-repo.js";

const constant = "use constant VALUE => 1;";
const usesValue = "sub read_value { VALUE() } read_value();";
const target = "main.pl#main::VALUE";
const refersToValue = (f: ReturnType<typeof perlRepo>) => semanticEdges(f.graph()).some(edge => edge.includes(`main.pl#main::read_value -> ${target} `));

test("runtime module initialization cannot replace an already compiled constant value", async () => {
  for (const mutator of [
    "package Mutator; *main::VALUE = sub { 2 }; 1;",
    "package Mutator; BEGIN { *main::VALUE = sub { 2 } } 1;",
    "package Mutator; eval $runtime_code; 1;",
    "package main; sub VALUE () { 2 } 1;",
  ]) {
    const f = perlRepo({ "main.pl": `${constant} require Mutator; ${usesValue}`, "lib/Mutator.pm": mutator });
    try { await f.build(); assert.ok(refersToValue(f), mutator); }
    finally { f.close(); }
  }
});

test("module loads during compilation can replace the constant before its use is compiled", async () => {
  for (const load of ["use Mutator ();", "no Mutator;", "BEGIN { require Mutator }"]) {
    const f = perlRepo({ "main.pl": `${constant} ${load} ${usesValue}`,
      "lib/Mutator.pm": "package Mutator; *main::VALUE = sub { 2 }; 1;" });
    try { await f.build(); assert.ok(!refersToValue(f), load); }
    finally { f.close(); }
  }
});

test("same-unit compile mutations and helper calls prevent an old constant proof", async () => {
  for (const change of ["BEGIN { *VALUE = sub { 2 } }", "BEGIN { eval $runtime_code }", "sub change { *VALUE = sub { 2 } } BEGIN { change() }"]) {
    const f = perlRepo({ "main.pl": `${constant} ${change} ${usesValue}` });
    try { await f.build(); assert.ok(!refersToValue(f), change); }
    finally { f.close(); }
  }
});

test("constant declarations after a compile load and uses before a later BEGIN retain their value", async () => {
  for (const main of [`use Mutator (); ${constant} ${usesValue}`, `${constant} ${usesValue} BEGIN { require Mutator }`]) {
    const f = perlRepo({ "main.pl": main, "lib/Mutator.pm": "package Mutator; *main::VALUE = sub { 2 }; 1;" });
    try { await f.build(); assert.ok(refersToValue(f), main); }
    finally { f.close(); }
  }
});

test("ampersand calls do not acquire the compiled constant value", async () => {
  const f = perlRepo({ "main.pl": `${constant} require Mutator; sub read_value { &VALUE() } read_value();`,
    "lib/Mutator.pm": "package Mutator; *main::VALUE = sub { 2 }; 1;" });
  try { await f.build(); assert.ok(!refersToValue(f)); }
  finally { f.close(); }
});

test("changing only a module provider updates runtime calls without changing compiled constants", async () => {
  const f = perlRepo({ "main.pl": `${constant} require Mutator; ${usesValue} sub invoke_value { &VALUE() } invoke_value();`, "lib/Mutator.pm": "package Mutator; 1;" });
  try {
    await f.build();
    assert.ok(refersToValue(f));
    const cold = f.bytes();
    assert.equal((await f.build()).parsed, 0);
    assert.equal(f.bytes(), cold);
    f.write("lib/Mutator.pm", "package Mutator; *main::VALUE = sub { 2 }; 1;");
    assert.equal((await f.build()).parsed, 1);
    assert.ok(refersToValue(f));
    assert.ok(!semanticEdges(f.graph()).some(edge => edge.includes(`main.pl#main::invoke_value -> ${target} `)));
  } finally { f.close(); }
});
