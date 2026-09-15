import { test } from "node:test";
import assert from "node:assert/strict";
import { smallestEnclosing } from "../src/graph/intervals.js";

test("interval sweep exactly matches stable scan/sort for overlaps, ties and half-open endpoints", () => {
  let state = 173;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  for (let trial = 0; trial < 100; trial++) {
    const definitions = Array.from({ length: 100 }, (_, id) => {
      const startIndex = random() % 200;
      return { id, startIndex, endIndex: startIndex + random() % 100 - 5 };
    });
    definitions.push({ ...definitions[0], id: 100 });
    const offsets = [0, 300, ...definitions.flatMap((d) => [d.endIndex, d.startIndex]), ...Array.from({ length: 100 }, () => random() % 300)];
    const expected = offsets.map((at) => definitions.filter((d) => d.startIndex <= at && at < d.endIndex)
      .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0]);
    assert.deepEqual(smallestEnclosing(definitions, offsets), expected);
  }
  assert.deepEqual(smallestEnclosing([], [0, 1]), [undefined, undefined]);
});
