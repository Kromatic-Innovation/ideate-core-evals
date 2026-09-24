// non-inferiority-margin.test.mjs -- the pure functions behind
// docs/PREREGISTRATION.md Appendix R (issue #179): the SE formula
// reproducing both registered tables, delta derived at each basis, the
// counter-example flipping verdict between bases, and the registered
// constant in contrasts.mjs staying pinned to what this script derives.
//
// No sidecar, no CSV, no network: every input here is a REGISTERED
// constant (Appendix G item 1 / Appendix J item 5), exactly per this
// file's non-re-fitting header comment.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SIGMA2_BA_60,
  SIGMA2_E_60,
  SIGMA2_BA_30,
  SIGMA2_E_30,
  REGISTERED_B,
  REGISTERED_R,
  Z_ALPHA_ONE_SIDED,
  Z_ALPHA_HOLM_WORST_CASE,
  seForDesign,
  deriveDelta,
  contrastSD,
  standardNormalCdf,
  powerAtZero,
  marginVerdict,
  runReproductionChecks,
} from "./non-inferiority-margin.mjs";
import { REGISTERED_H2_H4_DELTA } from "./contrasts.mjs";

// ── The SE formula reproduces both registered tables ──────────────────────

test("seForDesign reproduces Appendix J item 5's ~60-basis table to 2 decimal places", () => {
  const TABLE = { "24,2": 0.897, "48,2": 0.634, "48,3": 0.614 };
  for (const [key, expected] of Object.entries(TABLE)) {
    const [B, R] = key.split(",").map(Number);
    const actual = seForDesign(SIGMA2_BA_60, SIGMA2_E_60, B, R);
    assert.ok(Math.abs(actual - expected) <= 0.005, `B=${B} R=${R}: got ${actual.toFixed(4)}, table says ${expected}`);
  }
});

test("seForDesign reproduces Appendix G item 2's ~30-basis registered-design row (B=24, R=2 -> 0.56)", () => {
  const actual = seForDesign(SIGMA2_BA_30, SIGMA2_E_30, 24, 2);
  assert.equal(Number(actual.toFixed(2)), 0.56);
});

test("runReproductionChecks: all four registered cells PASS", () => {
  const results = runReproductionChecks();
  assert.equal(results.length, 4);
  for (const r of results) {
    assert.ok(r.pass, `${r.label}: computed ${r.computed} vs registered ${r.expected} should be within tolerance`);
  }
});

// ── delta derivation at each basis ─────────────────────────────────────────

test("deriveDelta at the ~60 basis (registered for H2/H4) is 2.7976", () => {
  assert.equal(Number(deriveDelta(SIGMA2_BA_60).toFixed(4)), 2.7976);
});

test("deriveDelta at the ~30 basis (counter-example only) is 1.0995", () => {
  assert.equal(Number(deriveDelta(SIGMA2_BA_30).toFixed(4)), 1.0995);
});

test("the ~60/~30 delta ratio is ~2.5445x -- a materially different margin, not a rounding wobble", () => {
  const ratio = deriveDelta(SIGMA2_BA_60) / deriveDelta(SIGMA2_BA_30);
  assert.ok(Math.abs(ratio - 2.5445) < 0.001, `ratio ${ratio} should be ~2.5445`);
  assert.ok(ratio > 2, "the two bases must differ by more than a rounding-level amount");
});

test("contrastSD (the LESS conservative, non-registered reading) is sqrt(2*sigma2_ba) = 3.9564 at the ~60 basis", () => {
  assert.equal(Number(contrastSD(SIGMA2_BA_60).toFixed(4)), 3.9564);
  assert.ok(contrastSD(SIGMA2_BA_60) > deriveDelta(SIGMA2_BA_60), "the contrast SD must exceed the registered per-arm delta (the conservative choice)");
});

// ── the counter-example flips verdict between bases ────────────────────────

test("an observed deficit of -2.00 is INSIDE the registered ~60-basis margin but OUTSIDE the transported ~30-basis one", () => {
  const delta60 = deriveDelta(SIGMA2_BA_60);
  const delta30 = deriveDelta(SIGMA2_BA_30);
  assert.equal(marginVerdict(-2.0, delta60), "inside (non-inferior)");
  assert.equal(marginVerdict(-2.0, delta30), "outside (inferior)");
});

test("marginVerdict: a deficit exactly at -delta is NOT inside (boundary is exclusive)", () => {
  assert.equal(marginVerdict(-2.7976, 2.7976), "outside (inferior)");
});

// ── the normal CDF and power-at-zero context (reported, not targeted) ──────

test("standardNormalCdf: Phi(0) = 0.5 and is symmetric", () => {
  assert.ok(Math.abs(standardNormalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(standardNormalCdf(1.96) - (1 - standardNormalCdf(-1.96))) < 1e-6);
  assert.ok(Math.abs(standardNormalCdf(1.959964) - 0.975) < 1e-4, "z=1.959964 is the standard one-sided alpha=0.025 critical value");
});

test("powerAtZero at the registered design reproduces the two reported (not targeted) figures ~0.877 and ~0.707", () => {
  const se = seForDesign(SIGMA2_BA_60, SIGMA2_E_60, REGISTERED_B, REGISTERED_R);
  const delta = deriveDelta(SIGMA2_BA_60);
  const powerOneSided = powerAtZero(delta, se, Z_ALPHA_ONE_SIDED);
  const powerHolmWorst = powerAtZero(delta, se, Z_ALPHA_HOLM_WORST_CASE);
  assert.ok(Math.abs(powerOneSided - 0.877) < 0.001, `power (one-sided alpha=0.025) ${powerOneSided} should be ~0.877`);
  assert.ok(Math.abs(powerHolmWorst - 0.707) < 0.001, `power (Holm worst-case alpha=0.005) ${powerHolmWorst} should be ~0.707`);
});

// ── the drift guard: contrasts.mjs's registered constant must equal what
//    THIS script derives, or the document and the code have silently
//    diverged from one another. This is the important test (per the issue's
//    own AC7 and the task brief that implements it). ──────────────────────

test("contrasts.mjs's REGISTERED_H2_H4_DELTA is EXACTLY the ~60-basis delta this script derives (at the document's registered 4-decimal precision)", () => {
  assert.equal(REGISTERED_H2_H4_DELTA, Number(deriveDelta(SIGMA2_BA_60).toFixed(4)));
  assert.equal(REGISTERED_H2_H4_DELTA, 2.7976);
});
