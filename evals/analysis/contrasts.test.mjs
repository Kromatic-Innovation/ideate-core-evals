import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastVector, armCoefficientName, evaluateContrast, buildRegisteredFamily, evaluateSpec, registeredFamilySlotCount, applyHolmVerdicts } from "./contrasts.mjs";
import { holmBonferroni } from "./multiplicity.mjs";

const COEF_NAMES = ["Intercept", "arm[T.B]", "arm[T.D]", "arm[T.E]", "arm[T.G]", "arm[T.H]"];

test("armCoefficientName: Intercept for the reference arm, dummy name otherwise", () => {
  assert.equal(armCoefficientName("A", "A"), "Intercept");
  assert.equal(armCoefficientName("B", "A"), "arm[T.B]");
});

test("contrastVector: builds a dense vector aligned to coefficientNames", () => {
  const v = contrastVector(COEF_NAMES, { "arm[T.E]": 1, "arm[T.D]": -1 });
  assert.deepEqual(v, [0, 0, -1, 1, 0, 0]);
});

test("contrastVector: rejects an unknown coefficient name", () => {
  assert.throws(() => contrastVector(COEF_NAMES, { "arm[T.Z]": 1 }), /unknown coefficient/);
});

// A simple diagonal-vcov fit, so hand-computed contrasts are easy to verify.
function diagonalFit(coefficients, variances) {
  const k = coefficients.length;
  const vcov = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? variances[i] : 0)));
  return { coefficients, coefficientNames: COEF_NAMES, vcov };
}

test("evaluateContrast: estimate and SE for a single-coefficient contrast", () => {
  const fit = diagonalFit([10, 1, 2, 3, 4, 5], [0, 0.25, 0.25, 0.25, 0.25, 0.25]);
  const c = contrastVector(COEF_NAMES, { "arm[T.D]": 1 });
  const r = evaluateContrast(fit, c);
  assert.equal(r.estimate, 2);
  assert.equal(r.se, 0.5);
  assert.ok(r.ci[0] < 2 && r.ci[1] > 2);
  assert.ok(r.p < 1 && r.p >= 0);
});

test("evaluateContrast: difference of two coefficients sums variances (independent case)", () => {
  const fit = diagonalFit([10, 1, 2, 3, 4, 5], [0, 0.25, 0.25, 0.25, 0.25, 0.25]);
  const c = contrastVector(COEF_NAMES, { "arm[T.E]": 1, "arm[T.D]": -1 });
  const r = evaluateContrast(fit, c);
  assert.equal(r.estimate, 1); // 3 - 2
  assert.ok(Math.abs(r.se - Math.sqrt(0.5)) < 1e-9);
});

test("evaluateContrast: throws on non-finite/non-positive contrast variance", () => {
  const fit = diagonalFit([10, 1, 2, 3, 4, 5], [0, 0, 0, 0, 0, 0]);
  const c = contrastVector(COEF_NAMES, { "arm[T.D]": 1 });
  assert.throws(() => evaluateContrast(fit, c), /non-finite or non-positive/);
});

test("evaluateContrast: length mismatch throws", () => {
  const fit = diagonalFit([1, 2], [1, 1]);
  assert.throws(() => evaluateContrast(fit, [1, 0, 0]), /does not match/);
});

// ── #46 QA SHOULD: R2's CR2 SEs must use the Student-t reference (fit.df),
//    not Wald z — R0/R1 (no fit.df) keep using z, which is correct there. ──

test("evaluateContrast: with fit.df present (R2), the CI is WIDER than the z-based (R0/R1) CI at the same estimate/se", () => {
  const noDfFit = diagonalFit([10, 1, 2, 3, 4, 5], [0, 0.25, 0.25, 0.25, 0.25, 0.25]);
  const c = contrastVector(COEF_NAMES, { "arm[T.D]": 1 });
  const zResult = evaluateContrast(noDfFit, c);

  const smallDfFit = { ...noDfFit, df: 3 }; // few clusters, per fitR2()'s df = clusters - 1
  const tResult = evaluateContrast(smallDfFit, c);

  assert.equal(tResult.estimate, zResult.estimate);
  assert.equal(tResult.se, zResult.se);
  const zWidth = zResult.ci[1] - zResult.ci[0];
  const tWidth = tResult.ci[1] - tResult.ci[0];
  assert.ok(tWidth > zWidth, `t-reference CI width ${tWidth} should exceed z-reference width ${zWidth} at df=3`);
  assert.equal(tResult.df, 3);
});

test("evaluateContrast: fit.df's two-sided p is larger than the z-based p for the same z-stat (t has fatter tails)", () => {
  const noDfFit = diagonalFit([10, 1, 2, 3, 4, 5], [0, 0.25, 0.25, 0.25, 0.25, 0.25]);
  const c = contrastVector(COEF_NAMES, { "arm[T.D]": 1 });
  const zResult = evaluateContrast(noDfFit, c);
  const tResult = evaluateContrast({ ...noDfFit, df: 4 }, c);
  assert.ok(tResult.p > zResult.p, `t-reference p ${tResult.p} should exceed z-reference p ${zResult.p} at df=4`);
});

test("buildRegisteredFamily: returns exactly 5 entries H1..H5", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"] });
  assert.deepEqual(family.map((f) => f.id), ["H1", "H2", "H3", "H4", "H5"]);
});

test("buildRegisteredFamily: H1 is mean(panel arms) - reference, expressed purely as offset coefficients", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D"] });
  const h1 = family[0];
  assert.equal(h1.weights["arm[T.B]"], 0.5);
  assert.equal(h1.weights["arm[T.D]"], 0.5);
  // Must NOT also subtract Intercept -- each offset coefficient already IS
  // (mean(armX) - mean(reference)), so an extra -1*Intercept would
  // double-count the reference arm's mean and flip the sign of a positive
  // panel effect (regression test for that exact bug).
  assert.equal(h1.weights["Intercept"], undefined);
});

test("buildRegisteredFamily: H1 estimate is correctly signed against a fit where every panel arm exceeds the reference", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D"] });
  const h1 = family[0];
  // Intercept (A's mean) = 10, B offset = +2, D offset = +4 -> H1 should be
  // the mean of the OFFSETS, +3 -- not -7 (which is what double-subtracting
  // Intercept would produce: mean(2,4) - 10 = -7).
  const fit = {
    coefficients: [10, 2, 4],
    coefficientNames: ["Intercept", "arm[T.B]", "arm[T.D]"],
    vcov: [[0.01, 0, 0], [0, 0.01, 0], [0, 0, 0.01]],
  };
  const result = evaluateSpec(h1, fit);
  assert.equal(result.estimate, 3);
});

test("buildRegisteredFamily: H2/H4 without delta are estimation-only when evaluated", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E"] });
  const fit = diagonalFit([10, 1, 2, 3, 4, 5], [0.1, 0.25, 0.25, 0.25, 0.25, 0.25]);
  const h2 = evaluateSpec(family[1], fit);
  assert.equal(h2.deltaUnregistered, true);
  assert.equal(h2.supported, undefined);
});

test("buildRegisteredFamily: H2 with delta computes a one-sided margin p, no verdict until Holm-corrected", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E"], delta: 0.5 });
  const fit = diagonalFit([10, 1, 2, 3, 4, 5], [0.1, 0.01, 0.01, 0.01, 0.01, 0.01]);
  const h2 = evaluateSpec(family[1], fit); // E - D = 3 - 2 = 1, se small -> well above -0.5
  assert.equal(h2.deltaUnregistered, undefined);
  assert.equal(h2.oneSided, true);
  assert.ok(h2.p < 0.001, `margin p ${h2.p} should be tiny (estimate well clear of -delta)`);
  // evaluateSpec never sets a verdict directly -- see applyHolmVerdicts().
  assert.equal(h2.supported, undefined);
});

test("buildRegisteredFamily: H3 expands to two subcontrasts, each a one-sided p against 0", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"], h3TargetVsBest: ["G", "D", "H"] });
  const h3 = family[2];
  assert.equal(h3.subcontrasts.length, 2);
  assert.deepEqual(h3.subcontrasts.map((s) => s.id), ["H3:G-D", "H3:G-H"]);

  // G (coeff 4) beats D (2) but not H (5) -- G-H should have a large p (not
  // small), G-D a tiny one.
  const fit = diagonalFit([10, 1, 2, 3, 4, 5], [0.1, 0.001, 0.001, 0.001, 0.001, 0.001]);
  const results = evaluateSpec(h3, fit);
  assert.equal(results.length, 2);
  const gMinusD = results.find((r) => r.id === "H3:G-D");
  const gMinusH = results.find((r) => r.id === "H3:G-H");
  assert.ok(gMinusD.p < 0.001, `G-D p ${gMinusD.p} should be tiny (2 SDs above 0)`);
  assert.ok(gMinusH.p > 0.99, `G-H p ${gMinusH.p} should be ~1 (estimate far below 0)`);
  assert.equal(gMinusD.supported, undefined); // not until Holm-corrected
});

test("buildRegisteredFamily: H5 is a named stub, evaluated as unimplemented but still occupies a Holm slot (p=1)", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B"] });
  const h5 = evaluateSpec(family[4], diagonalFit([1, 1], [1, 1]));
  assert.equal(h5.unimplemented, true);
  assert.equal(h5.p, 1);
});

test("buildRegisteredFamily: requires panelArms", () => {
  assert.throws(() => buildRegisteredFamily({ referenceArm: "A" }), /panelArms is required/);
});

// ── MUST #3 (#46 QA): the reference arm must never sneak into a contrast
//    member -- armCoefficientName(referenceArm, referenceArm) resolves to
//    "Intercept", which contrastVector() accepts (it exists), so this
//    footgun fails SILENTLY unless buildRegisteredFamily() guards it. ──────

test("buildRegisteredFamily: refuses a reference arm present in panelArms (the H1-intercept bug, direct)", () => {
  assert.throws(
    () => buildRegisteredFamily({ referenceArm: "A", panelArms: ["A", "B", "D"] }),
    /reference arm 'A' cannot also appear as a contrast member/,
  );
});

test("buildRegisteredFamily: refuses a reference arm in h2Pair", () => {
  assert.throws(
    () => buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D"], h2Pair: ["A", "D"] }),
    /reference arm 'A' cannot also appear as a contrast member/,
  );
});

test("buildRegisteredFamily: refuses a reference arm in h4Pair", () => {
  assert.throws(
    () => buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D"], h4Pair: ["B", "A"] }),
    /reference arm 'A' cannot also appear as a contrast member/,
  );
});

test("buildRegisteredFamily: refuses a reference arm in h3TargetVsBest (challenger or a baseline)", () => {
  assert.throws(
    () => buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "H"], h3TargetVsBest: ["A", "D", "H"] }),
    /reference arm 'A' cannot also appear as a contrast member/,
  );
  assert.throws(
    () => buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "G", "H"], h3TargetVsBest: ["G", "A", "H"] }),
    /reference arm 'A' cannot also appear as a contrast member/,
  );
});

// ── registeredFamilySlotCount() / applyHolmVerdicts(): the family is 6
//    SLOTS (H1+H2+H4+H5=1 each, H3=2), and verdicts only exist after Holm
//    correction over exactly that many p-values (#46 QA MUST #1 + #2). ────

test("registeredFamilySlotCount: 6 slots across 5 hypotheses (H3 expands to 2)", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"] });
  assert.equal(registeredFamilySlotCount(family), 6);
});

test("registeredFamilySlotCount: independent of whether H5 is wired -- wiring it later does not change the count", () => {
  // H5 is always present as a stub (unimplemented) in the current family;
  // this pins that its slot is already counted, so implementing #45/B5
  // later cannot silently change m from what it already was.
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"] });
  assert.equal(family.find((f) => f.id === "H5").unimplemented, true);
  assert.equal(registeredFamilySlotCount(family), 6);
});

test("applyHolmVerdicts: a raw-significant contrast becomes not-supported once Holm's step-down correction catches up to it", () => {
  // Regression for #46 QA MUST #1: H2/H3/H4 must consult the Holm-adjusted
  // p, not a raw CI/p, when deciding `supported`. H2's own raw p (0.01)
  // clears the raw one-sided 0.025 threshold comfortably -- but it is only
  // the family's SECOND-smallest p-value, so Holm's step-down running-max
  // (rank-1 multiplier 5, carrying forward rank-0's already-adjusted floor)
  // pushes its ADJUSTED p to 0.05, above threshold.
  const flat = [
    { id: "OTHER-SMALLEST", p: 0.0001, oneSided: true },
    { id: "H2", kind: "non-inferiority", oneSided: true, p: 0.01 },
    { id: "OTHER-1", p: 0.9, oneSided: true },
    { id: "OTHER-2", p: 0.9, oneSided: true },
    { id: "OTHER-3", p: 0.9, oneSided: true },
    { id: "OTHER-4", p: 0.9, oneSided: true },
  ];
  const familySize = 6;
  const holmAdjusted = holmBonferroni(flat.map((r) => r.p), { familySize });
  const verdicts = applyHolmVerdicts(flat, holmAdjusted);
  const h2 = verdicts.find((r) => r.id === "H2");
  assert.ok(h2.p < 0.025, "sanity: H2's RAW p clears the one-sided threshold");
  assert.ok(h2.holmP > 0.025, `H2's Holm-adjusted p ${h2.holmP} should exceed the one-sided 0.025 threshold`);
  assert.equal(h2.supported, false);
});

test("applyHolmVerdicts: length mismatch between flatResults and holmAdjusted is a hard error", () => {
  assert.throws(() => applyHolmVerdicts([{ id: "H1", p: 0.01 }], [0.01, 0.02]), /does not match/);
});
