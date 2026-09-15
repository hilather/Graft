import { test } from "node:test";
import assert from "node:assert/strict";
import { perlCallerClosures } from "../src/graph/perl-call-closure.js";

test("caller components union recursive and transitive effects without crossing disconnected components", () => {
  const edges = new Map([
    ["a", ["b", "c", "b"]], ["b", ["a"]], ["c", ["d"]],
    ["d", []], ["e", ["a"]], ["unrelated", []],
  ]);
  const local = new Map([
    ["a", new Uint32Array([1, 0])], ["b", new Uint32Array([2, 0])],
    ["c", new Uint32Array([0x80000000, 0])], ["d", new Uint32Array([0, 1])],
    ["e", new Uint32Array([16, 0])], ["unrelated", new Uint32Array([32, 0])],
  ]);
  const closures = perlCallerClosures(edges, local, 2);
  assert.deepEqual([...closures.get("a")!], [0x80000003, 1]);
  assert.deepEqual([...closures.get("b")!], [0x80000003, 1]);
  assert.deepEqual([...closures.get("c")!], [0x80000000, 1]);
  assert.deepEqual([...closures.get("d")!], [0, 1]);
  assert.deepEqual([...closures.get("e")!], [0x80000013, 1]);
  assert.deepEqual([...closures.get("unrelated")!], [32, 0]);
});

test("long caller chains do not depend on the JavaScript call-stack limit", () => {
  const edges = new Map(Array.from({ length: 20000 }, (_, i) => [`s${i}`, [`s${i + 1}`]]));
  const local = new Map([["s0", new Uint32Array([1])], ["s20000", new Uint32Array([2])]]);
  const closures = perlCallerClosures(edges, local, 1);
  assert.deepEqual([...closures.get("s0")!], [3]);
  assert.deepEqual([...closures.get("s10000")!], [2]);
  assert.deepEqual([...closures.get("s20000")!], [2]);
});
