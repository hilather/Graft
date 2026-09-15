import { test } from "node:test";
import assert from "node:assert/strict";
import { SizedCache } from "../src/graph/sized-cache.js";

test("retention follows bytes and recency, allowing many small repositories", () => {
  const cache = new SizedCache<string>(32 * 1024);
  for (let i = 0; i < 32; i++) cache.set(String(i), `repo${i}`, 100);
  assert.equal(cache.get("0"), "repo0");
  cache.set("large", "large repo", 16 * 1024);
  assert.equal(cache.get("0"), "repo0", "recently used entry survives");
  for (let i = 1; i <= 16; i++) assert.equal(cache.get(String(i)), undefined);
  for (let i = 17; i < 32; i++) assert.equal(cache.get(String(i)), `repo${i}`);
  assert.equal(cache.get("large"), "large repo");
});

test("oversized snapshots bypass retention without evicting other hot entries", () => {
  const cache = new SizedCache<object>(2048);
  const a = {}, b = {};
  cache.set("a", a, 500);
  cache.set("b", b, 500);
  cache.set("huge", {}, 4096);
  assert.equal(cache.get("huge"), undefined);
  assert.strictEqual(cache.get("a"), a);
  assert.strictEqual(cache.get("b"), b);
  cache.set("a", {}, 4096);
  assert.equal(cache.get("a"), undefined, "an oversized replacement must not leave a stale value cached");
  assert.strictEqual(cache.get("b"), b);
});

test("replacement and invalidation release the old entry's byte charge", () => {
  const cache = new SizedCache<string>(4096);
  cache.set("a", "old", 3072);
  cache.set("a", "new", 1024);
  cache.set("b", "other", 3072);
  assert.equal(cache.get("a"), "new");
  cache.delete("b");
  cache.delete("b");
  cache.set("c", "replacement", 3072);
  assert.equal(cache.get("a"), "new");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("c"), "replacement");
});
