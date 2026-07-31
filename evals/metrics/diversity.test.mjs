// diversity.test.mjs — hermetic tests for poolDiversity and collapseRate.
import { test } from "node:test";
import assert from "node:assert/strict";

import { poolDiversity, collapseRate } from "./diversity.mjs";

// ── poolDiversity ────────────────────────────────────────────────────────

test("poolDiversity of identical vectors is exactly 0", () => {
  const v = [0.6, 0.8, 0];
  const pool = Array.from({ length: 5 }, () => v);
  assert.equal(poolDiversity(pool), 0);
});

test("poolDiversity of orthogonal unit vectors is 1", () => {
  assert.equal(poolDiversity([[1, 0], [0, 1]]), 1);
});

test("poolDiversity requires at least 2 items", () => {
  assert.throws(() => poolDiversity([[1, 0]]), /at least 2/);
  assert.throws(() => poolDiversity([]), /at least 2/);
});

test("poolDiversity is the mean, not sum, of pairwise distances", () => {
  // 3 orthogonal-ish 3D basis vectors: every pairwise distance is 1, mean is 1.
  const pool = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  assert.ok(Math.abs(poolDiversity(pool) - 1) < 1e-12);
});

// ── collapseRate ─────────────────────────────────────────────────────────

test("collapseRate is 0 when every candidate survives (distinct_k == raw count)", () => {
  assert.equal(collapseRate(30, 30), 0);
});

test("collapseRate approaches 1 as survivors shrink toward 1 out of many", () => {
  const rate = collapseRate(1, 30);
  assert.ok(Math.abs(rate - 29 / 30) < 1e-12);
});

test("collapseRate rejects survivors exceeding raw count (impossible state)", () => {
  assert.throws(() => collapseRate(31, 30), /cannot exceed/);
});

test("collapseRate validates its inputs", () => {
  assert.throws(() => collapseRate(-1, 30), /non-negative/);
  assert.throws(() => collapseRate(5, 0), /positive integer/);
  assert.throws(() => collapseRate(5, 1.5), /positive integer/);
});
