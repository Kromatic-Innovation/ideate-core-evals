// variance-components.test.mjs -- the two PURE functions behind
// docs/PREREGISTRATION.md Appendix G. No sidecar, no venv, no CSV: the mixed
// model is the sidecar's job and is tested there, and CI runs this file with an
// empty node_modules.
//
// What is worth testing here is exactly what the appendix asserts on its own
// authority: that the SE formula applied to the NEW components is the SAME one
// already registered in §3.4, and that sigma^2_e means what Appendix E item 7's
// "pooled within-(arm x brief) residual variance" line says it means.
import { test } from "node:test";
import assert from "node:assert/strict";

import { contrastSE, pooledWithinCellVariance, n60ScaleBasis, MATCHED_N30_ARMS, REFERENCE_ARM, N60_ARM, N30_CENTRE_ARM } from "./variance-components.mjs";

// ── The auditable check Appendix G item 2 claims ─────────────────────────────

test("the SE formula reproduces Appendix E item 7's published table from the SUPERSEDED components -- this is what makes the supersession auditable rather than asserted", () => {
  // Verbatim from Appendix E item 7 (sigma^2_ba 77.85, sigma^2_e 6.82). If this
  // drifts, the appendix is applying a DIFFERENT formula under the name of the
  // registered one, which is the precise move Appendix G exists to avoid.
  const REGISTERED_TABLE = {
    6: { 1: 5.31, 2: 5.2, 3: 5.17, 5: 5.14 },
    12: { 1: 3.76, 2: 3.68, 3: 3.65, 5: 3.63 },
    24: { 1: 2.66, 2: 2.6, 3: 2.58, 5: 2.57 },
    48: { 1: 1.88, 2: 1.84, 3: 1.83, 5: 1.82 },
  };
  for (const [B, row] of Object.entries(REGISTERED_TABLE)) {
    for (const [R, expected] of Object.entries(row)) {
      const actual = contrastSE(77.85, 6.82, Number(B), Number(R));
      assert.equal(Number(actual.toFixed(2)), expected, `B=${B} R=${R}: got ${actual.toFixed(4)}, table says ${expected}`);
    }
  }
});

// ── Appendix I item 3: the ~60-pool basis ─────────────────────────────────

/** Two replicates of one (arm x brief) cell, as CSV-shaped rows. */
function cell(arm, brief, a, b) {
  return [
    { arm, brief, state: "completed", distinct_k: String(a) },
    { arm, brief, state: "completed", distinct_k: String(b) },
  ];
}

test("n60ScaleBasis: sigma^2_e at ~60 is MEASURED and sigma^2_ba at ~60 is the measured ratio applied to the ~30 fit", () => {
  // Centre arm: within-cell deviations +/-1 -> ss = 2 per cell, df 1 -> 2.0.
  // N=60 arm: deviations +/-2 -> ss = 8 per cell, df 1 -> 8.0. Ratio 4.
  const rows = [
    ...cell(N30_CENTRE_ARM, "b1", 9, 11),
    ...cell(N30_CENTRE_ARM, "b2", 19, 21),
    ...cell(N60_ARM, "b1", 18, 22),
    ...cell(N60_ARM, "b2", 38, 42),
  ];
  const basis = n60ScaleBasis(rows, 1.5);
  assert.equal(basis.sigma2eAt60, 8);
  assert.equal(basis.sigma2eAt30Centre, 2);
  assert.equal(basis.varianceRatio, 4);
  assert.equal(basis.sigma2BriefArmAt60, 6, "the ~30 interaction term transported by the measured ratio");
});

test("n60ScaleBasis: the ratio's denominator is the CENTRE arm alone, not a pool that a high-variance arm can dominate", () => {
  // The appendix's actual reason for choosing S1-C0 over the pooled matched
  // residual: S1-SPRAG's within-cell variance is ~4x every other arm's, so
  // pooling drags a STANCE effect into a POOL-SIZE ratio and pushes it below
  // one. Here a wild third arm at the ~30 scale must not move the answer.
  const base = [
    ...cell(N30_CENTRE_ARM, "b1", 9, 11),
    ...cell(N60_ARM, "b1", 18, 22),
  ];
  const withWildArm = [...base, ...cell("S1-SPRAG", "b1", 0, 100)];
  assert.equal(n60ScaleBasis(withWildArm, 1).varianceRatio, n60ScaleBasis(base, 1).varianceRatio);
});

test("n60ScaleBasis: the mean ratio is reported alongside, as the independent count-variance corroboration", () => {
  const rows = [
    ...cell(N30_CENTRE_ARM, "b1", 9, 11), // mean 10
    ...cell(N60_ARM, "b1", 18, 22), // mean 20
  ];
  const basis = n60ScaleBasis(rows, 1);
  assert.equal(basis.meanRatio, 2, "distinct_k is a count; if variance tracks the mean these two ratios should agree");
  assert.equal(basis.varianceRatio, 4);
  // Deliberately DISAGREEING fixture: the two ratios are computed from
  // different quantities and must not be wired to each other.
  assert.notEqual(basis.meanRatio, basis.varianceRatio);
});

test("n60ScaleBasis: the ratio ships with its interval, because the sizing inherits the imprecision", () => {
  const rows = [...cell(N30_CENTRE_ARM, "b1", 9, 11), ...cell(N60_ARM, "b1", 18, 22)];
  const { varianceRatio, varianceRatioCI } = n60ScaleBasis(rows, 1);
  const [lo, hi] = varianceRatioCI;
  assert.ok(lo < varianceRatio && varianceRatio < hi, "the point estimate sits inside its own interval");
  assert.ok(Math.abs(lo * hi - varianceRatio ** 2) < 1e-9, "an F-based ratio interval is multiplicatively symmetric about the estimate");
  assert.ok(hi / varianceRatio > 3, "a ratio on df 12 vs df 12 is imprecise, and the appendix must not present it as measured");
});

test("the same formula on the matched-N=30 components reproduces Appendix G item 2's registered table", () => {
  const G = { 6: [1.45, 1.12, 0.99, 0.86], 12: [1.03, 0.79, 0.7, 0.61], 24: [0.73, 0.56, 0.49, 0.43], 48: [0.51, 0.4, 0.35, 0.3] };
  for (const [B, expected] of Object.entries(G)) {
    const actual = [1, 2, 3, 5].map((R) => Number(contrastSE(1.2088343623079842, 5.118055555555555, Number(B), R).toFixed(2)));
    assert.deepEqual(actual, expected, `B=${B}`);
  }
});

test("the SE formula on the ~60 basis reproduces Appendix I item 3's registered Stage 1b table", () => {
  // Verbatim from Appendix I item 3, on the transported components
  // (sigma^2_ba 2.3562, sigma^2_e 4.7917). Same formula as §3.4 and Appendix
  // G -- a different one here would mean the appendix sized Stage 1b under a
  // rule the registration does not contain.
  const I = {
    6: [1.544, 1.259, 1.148],
    12: [1.091, 0.89, 0.812],
    24: [0.772, 0.629, 0.574],
    36: [0.63, 0.514, 0.469],
    48: [0.546, 0.445, 0.406],
  };
  for (const [B, expected] of Object.entries(I)) {
    const actual = [1, 2, 3].map((R) => Number(contrastSE(2.3562, 4.7917, Number(B), R).toFixed(3)));
    assert.deepEqual(actual, expected, `B=${B}`);
  }
  // And the registered design's MDE, at the Holm-adjusted multiplier for a
  // family of two -- the number a Stage 1b result is read against.
  const se = contrastSE(2.3562, 4.7917, 24, 2);
  assert.equal(Number((3.08 * se).toFixed(2)), 1.94);
});

test("the formula reproduces Stage 1a's OWN achieved contrast SE -- the design arithmetic and the fitted model agree on the design actually executed", () => {
  // The matched fit's vcov reports 0.7925 for every off-centre arm contrast at
  // 12 briefs x 2 replicates. A formula that did not land on the same number
  // would be describing some other design.
  assert.equal(contrastSE(1.2088343623079842, 5.118055555555555, 12, 2).toFixed(4), "0.7925");
});

test("contrastSE: briefs win per CELL SPENT at every ratio -- the design principle Appendix G item 3 says did NOT invert", () => {
  // At a fixed cell budget C = B*R, SE^2 = (2/C)(R*sigma^2_ba + sigma^2_e),
  // which is increasing in R. Checked against both the registered and the
  // superseded components, because item 3's claim is that this held under BOTH.
  for (const [ba, e] of [
    [1.2088343623079842, 5.118055555555555],
    [77.85, 6.82],
  ]) {
    const C = 48;
    const ses = [1, 2, 3].map((R) => contrastSE(ba, e, C / R, R));
    assert.ok(ses[0] < ses[1] && ses[1] < ses[2], `spending a fixed ${C} cells on replicates instead of briefs must never lower SE (ba=${ba})`);
  }
});

test("contrastSE: replicates DO buy power at fixed B under the new components, and did not under the old -- the half of item 3 that did invert", () => {
  const newDrop = 1 - contrastSE(1.2088343623079842, 5.118055555555555, 12, 2) / contrastSE(1.2088343623079842, 5.118055555555555, 12, 1);
  const oldDrop = 1 - contrastSE(77.85, 6.82, 12, 2) / contrastSE(77.85, 6.82, 12, 1);
  assert.ok(newDrop > 0.2, `R=1->2 at B=12 should cut SE materially under the new components, got ${(newDrop * 100).toFixed(1)}%`);
  assert.ok(oldDrop < 0.05, `and barely at all under the superseded ones, got ${(oldDrop * 100).toFixed(1)}%`);
});

// ── sigma^2_e ──────────────────────────────────────────────────────────

test("pooledWithinCellVariance: pools WITHIN (arm x brief), never across -- a between-cell difference must not leak into the residual", () => {
  // Two cells, each with replicates 10 and 12: within-cell ss is 2 each, df 1
  // each, so sigma^2_e = 4/2 = 2. The cells' MEANS are deliberately far apart
  // (11 and 111) -- a function that pooled across cells would return something
  // in the thousands.
  const rows = [
    { arm: "A", brief: "b1", distinct_k: "10" },
    { arm: "A", brief: "b1", distinct_k: "12" },
    { arm: "A", brief: "b2", distinct_k: "110" },
    { arm: "A", brief: "b2", distinct_k: "112" },
  ];
  const out = pooledWithinCellVariance(rows);
  assert.equal(out.sigma2, 2);
  assert.equal(out.df, 2);
  assert.equal(out.cells, 2);
});

test("pooledWithinCellVariance: a singleton cell contributes NO degrees of freedom -- a failed replicate must not read as 'this cell had no variance'", () => {
  const withSingleton = pooledWithinCellVariance([
    { arm: "A", brief: "b1", distinct_k: "10" },
    { arm: "A", brief: "b1", distinct_k: "12" },
    { arm: "A", brief: "b2", distinct_k: "99" }, // lone replicate -- the Stage 1a failure shape
  ]);
  assert.equal(withSingleton.df, 1, "only the complete pair contributes");
  assert.equal(withSingleton.cells, 1);
  assert.equal(withSingleton.sigma2, 2, "and the singleton does not drag the estimate toward zero");
});

test("pooledWithinCellVariance: divides by SUMMED degrees of freedom, not by cell count -- the two coincide at R=2 and diverge everywhere else", () => {
  // Every other fixture here has exactly two replicates per cell, where df per
  // cell is 1 and `df === cells` -- so a function that divided by the wrong one
  // would return the right answer on all of them. (It did: this test was added
  // after a mutation swapping df for cells survived the rest of the file.)
  // Stage 1a ran at R=2, but Appendix G's table is read at R=1..5, so the
  // distinction is load-bearing for any future re-estimate.
  //
  // One cell, three replicates 10/12/14: mean 12, ss = 4+0+4 = 8, df = 2,
  // cells = 1. Pooled variance is 8/2 = 4. Dividing by cells gives 8.
  const out = pooledWithinCellVariance([
    { arm: "A", brief: "b1", distinct_k: "10" },
    { arm: "A", brief: "b1", distinct_k: "12" },
    { arm: "A", brief: "b1", distinct_k: "14" },
  ]);
  assert.equal(out.df, 2);
  assert.equal(out.cells, 1);
  assert.equal(out.sigma2, 4, "ss/df, not ss/cells");
  assert.equal(out.sd, 2);
});

test("pooledWithinCellVariance: refuses rather than returning a number when nothing is estimable", () => {
  assert.throws(
    () =>
      pooledWithinCellVariance([
        { arm: "A", brief: "b1", distinct_k: "10" },
        { arm: "A", brief: "b2", distinct_k: "12" },
      ]),
    /not estimable/,
  );
});

test("the matched-N=30 basis is the registered arm set, named rather than derived from arms.config.json", () => {
  // Appendix G item 1 registers these six by name. Deriving them from the
  // config would mean a later arms.config edit silently changed which cells
  // reproduce a registered number.
  assert.deepEqual([...MATCHED_N30_ARMS].sort(), ["S1-C0", "S1-DIRECT", "S1-ELOW", "S1-EMAX", "S1-SCONTRA", "S1-SPRAG"]);
  assert.equal(MATCHED_N30_ARMS.length, 6);
  assert.equal(REFERENCE_ARM, "S1-C0", "the centre point, not arm A");
  assert.ok(MATCHED_N30_ARMS.includes(REFERENCE_ARM));
});
