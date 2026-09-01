import { test } from "node:test";
import assert from "node:assert/strict";
import { tCdf, tUpperTailP, tTwoSidedP, tQuantile } from "./distributions.mjs";

// Reference values: scipy.stats.t.ppf / t.cdf (well-known, widely tabulated).

test("tQuantile: matches known reference values", () => {
  assert.ok(Math.abs(tQuantile(0.975, 10) - 2.2281388519) < 1e-6);
  assert.ok(Math.abs(tQuantile(0.975, 5) - 2.5705818356) < 1e-6);
  assert.ok(Math.abs(tQuantile(0.975, 1) - 12.7062047362) < 1e-6);
  assert.ok(Math.abs(tQuantile(0.975, 100) - 1.9839715185) < 1e-4);
});

test("tQuantile: converges to the normal z-quantile (1.959964) as df grows large", () => {
  assert.ok(Math.abs(tQuantile(0.975, 1_000_000) - 1.959964) < 1e-3);
});

test("tQuantile: symmetric around 0", () => {
  const df = 7;
  assert.ok(Math.abs(tQuantile(0.9, df) + tQuantile(0.1, df)) < 1e-9);
});

test("tQuantile: 0.5 is exactly 0", () => {
  assert.equal(tQuantile(0.5, 10), 0);
});

test("tQuantile: rejects out-of-range p or non-positive df", () => {
  assert.throws(() => tQuantile(0, 10), /must be in \(0,1\)/);
  assert.throws(() => tQuantile(1, 10), /must be in \(0,1\)/);
  assert.throws(() => tQuantile(0.5, 0), /df must be > 0/);
});

test("tTwoSidedP: p at the critical t equals the complementary alpha", () => {
  const df = 10;
  const crit = tQuantile(0.975, df);
  assert.ok(Math.abs(tTwoSidedP(crit, df) - 0.05) < 1e-4);
});

test("tTwoSidedP: is symmetric in the sign of t", () => {
  assert.ok(Math.abs(tTwoSidedP(2, 8) - tTwoSidedP(-2, 8)) < 1e-12);
});

test("tUpperTailP: P(T>0) = 0.5 for any df", () => {
  assert.ok(Math.abs(tUpperTailP(0, 5) - 0.5) < 1e-9);
});

test("tUpperTailP: a large positive t has a tiny upper-tail probability", () => {
  assert.ok(tUpperTailP(10, 5) < 1e-4);
});

test("tCdf: is a valid CDF (0 at -Infinity-ish, 1 at +Infinity-ish, monotone)", () => {
  const df = 6;
  assert.ok(tCdf(-100, df) < 1e-4);
  assert.ok(tCdf(100, df) > 1 - 1e-4);
  assert.ok(tCdf(0, df) - 0.5 < 1e-9);
  assert.ok(tCdf(1, df) < tCdf(2, df));
});
