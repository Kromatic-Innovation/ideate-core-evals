// Tests for deterministic seeded presentation-order randomization (issue #4, AC4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderCandidates } from "./order.mjs";

function bigPool(n = 30) {
  return Array.from({ length: n }, (_, i) => `idea-${i}`);
}

test("orderCandidates returns a permutation: same multiset, same length", () => {
  const pool = bigPool();
  const ordered = orderCandidates(pool, 42);
  assert.equal(ordered.length, pool.length);
  assert.deepEqual([...ordered].sort(), [...pool].sort());
});

test("orderCandidates does not mutate the input array", () => {
  const pool = bigPool();
  const clone = pool.slice();
  orderCandidates(pool, 7);
  assert.deepEqual(pool, clone);
});

test("the SAME seed reproduces the exact same ordering", () => {
  const pool = bigPool();
  const a = orderCandidates(pool, 12345);
  const b = orderCandidates(pool, 12345);
  assert.deepEqual(a, b);
});

test("two DIFFERENT seeds produce different orderings on a large-enough list", () => {
  const pool = bigPool();
  const a = orderCandidates(pool, 1);
  const b = orderCandidates(pool, 2);
  assert.notDeepEqual(a, b, "different seeds should (overwhelmingly likely, n=30) produce a different order");
});

test("orderCandidates requires an explicit integer seed", () => {
  const pool = bigPool(5);
  assert.throws(() => orderCandidates(pool), /seed must be an explicit integer/);
  assert.throws(() => orderCandidates(pool, "42"), /seed must be an explicit integer/);
  assert.throws(() => orderCandidates(pool, 1.5), /seed must be an explicit integer/);
});

test("orderCandidates requires an array of candidates", () => {
  assert.throws(() => orderCandidates("not-an-array", 1), /candidates must be an array/);
});

test("orderCandidates handles trivial pools (0 and 1 elements) as no-op permutations", () => {
  assert.deepEqual(orderCandidates([], 1), []);
  assert.deepEqual(orderCandidates(["only"], 1), ["only"]);
});
