import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkQueue } from "../src/app/queue.js";

test("same-key bursts serialize, supersede pending jobs and leave slots for unrelated keys", async () => {
  const started: string[] = [];
  const active = new Set<string>();
  const release = new Map<string, () => void>();
  const errors: string[] = [];
  let peak = 0;
  const queue = new WorkQueue<string>(async (item) => {
    const key = item[0];
    assert.ok(!active.has(key), `overlap for ${key}`);
    active.add(key);
    peak = Math.max(peak, active.size);
    started.push(item);
    await new Promise<void>((resolve) => release.set(item, resolve));
    active.delete(key);
    if (item === "a1") throw new Error("expected failure");
  }, { concurrency: 2, onError: (_, key) => { errors.push(key); } });
  queue.push("a", "a1");
  queue.push("a", "a2");
  queue.push("a", "a3");
  queue.push("b", "b1");
  assert.deepEqual(started, ["a1", "b1"]);
  assert.equal(queue.size, 3);
  let drained = false;
  const drain = queue.drain().then(() => { drained = true; });
  release.get("a1")!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a1", "b1", "a3"]);
  assert.deepEqual(errors, ["a"]);
  assert.equal(drained, false);
  release.get("b1")!();
  release.get("a3")!();
  await drain;
  assert.equal(peak, 2);
  assert.equal(queue.size, 0);
});
