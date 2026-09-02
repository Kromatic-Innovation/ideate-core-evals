import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastVector, armCoefficientName, evaluateContrast, buildRegisteredFamily, evaluateSpec, registeredFamilySlotCount, applyHolmVerdicts, familyEstimability } from "./contrasts.mjs";
import { holmBonferroni } from "./multiplicity.mjs";
import { JUDGE_SCORE_BIAS_COEFFICIENT } from "./judgeScoreFrame.mjs";

const COEF_NAMES = ["Intercept", "arm[T.B]", "arm[T.D]", "arm[T.E]", "arm[T.G]", "arm[T.H]"];
const JUDGE_SCORE_COEF_NAMES = ["Intercept", "judge_provider[T.openai]", JUDGE_SCORE_BIAS_COEFFICIENT];

/** A judge-score-lane diagonal-vcov fit (issue #80) -- same shape as
 *  diagonalFit() below but with the judge-score model's own coefficientNames,
 *  never the arm lane's. */
function judgeScoreDiagonalFit(coefficients, variances) {
  const k = coefficients.length;
  const vcov = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? variances[i] : 0)));
  return { coefficients, coefficientNames: JUDGE_SCORE_COEF_NAMES, vcov };
}

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

test("buildRegisteredFamily: H2/H4 default to delta=0 (registered default), not estimation-only", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E"] });
  const fit = diagonalFit([10, 1, 2, 3, 4, 5], [0.1, 0.25, 0.25, 0.25, 0.25, 0.25]);
  const h2 = evaluateSpec(family[1], fit);
  assert.equal(h2.delta, 0);
  assert.equal(h2.deltaDeviatesFromRegistration, false);
  assert.equal(h2.oneSided, true);
  assert.ok(Number.isFinite(h2.p));
  assert.equal(h2.supported, undefined); // not until Holm-corrected
});

test("buildRegisteredFamily: H2 with an explicit delta computes a one-sided margin p and is flagged as a registration deviation", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E"], delta: 0.5 });
  const fit = diagonalFit([10, 1, 2, 3, 4, 5], [0.1, 0.01, 0.01, 0.01, 0.01, 0.01]);
  const h2 = evaluateSpec(family[1], fit); // E - D = 3 - 2 = 1, se small -> well above -0.5
  assert.equal(h2.delta, 0.5);
  assert.equal(h2.deltaDeviatesFromRegistration, true);
  assert.equal(h2.oneSided, true);
  assert.ok(h2.p < 0.001, `margin p ${h2.p} should be tiny (estimate well clear of -delta)`);
  // evaluateSpec never sets a verdict directly -- see applyHolmVerdicts().
  assert.equal(h2.supported, undefined);
});

test("buildRegisteredFamily: H3 combines its two sub-contrasts into ONE intersection-union-test p-value (Berger's IUT)", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"], h3TargetVsBest: ["G", "D", "H"] });
  const h3 = family[2];
  assert.equal(h3.kind, "iut-max-p");
  assert.equal(h3.components.length, 2);
  assert.deepEqual(h3.components.map((s) => s.id), ["H3:G-D", "H3:G-H"]);

  // G (coeff 4) beats D (2) but not H (5) -- G-H should have a large p (not
  // small), G-D a tiny one; H3's own p must be the MAX (the binding, weaker
  // sub-claim), not the min and not a separately Holm-adjusted pair.
  const fit = diagonalFit([10, 1, 2, 3, 4, 5], [0.1, 0.001, 0.001, 0.001, 0.001, 0.001]);
  const result = evaluateSpec(h3, fit);
  assert.equal(result.oneSided, true);
  const gMinusD = result.components.find((r) => r.id === "H3:G-D");
  const gMinusH = result.components.find((r) => r.id === "H3:G-H");
  assert.ok(gMinusD.p < 0.001, `G-D p ${gMinusD.p} should be tiny (2 SDs above 0)`);
  assert.ok(gMinusH.p > 0.99, `G-H p ${gMinusH.p} should be ~1 (estimate far below 0)`);
  assert.equal(result.p, gMinusH.p, "H3's p should be the MAX (binding) component's p, i.e. G-H's");
  assert.equal(result.supported, undefined); // not until Holm-corrected
});

test("buildRegisteredFamily: H5 is a named stub, evaluated as unimplemented but still occupies a Holm slot (p=1)", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B"] });
  const h5 = evaluateSpec(family[4], diagonalFit([1, 1], [1, 1]));
  assert.equal(h5.unimplemented, true);
  assert.equal(h5.p, 1);
});

// ── H5 wired (issue #80): opts.h5Wired: true produces a REAL spec, evaluated
//    against a judge-score fit -- the contrast must actually READ the fit's
//    bias coefficient, not return a constant regardless of input. ──────────

test("buildRegisteredFamily: opts.h5Wired produces a real spec (not unimplemented) targeting JUDGE_SCORE_BIAS_COEFFICIENT", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B"], h5Wired: true });
  const h5Spec = family[4];
  assert.equal(h5Spec.id, "H5");
  assert.equal(h5Spec.unimplemented, undefined);
  assert.deepEqual(h5Spec.weights, { [JUDGE_SCORE_BIAS_COEFFICIENT]: 1 });
});

test("H5 (wired) goes RED when the bias coefficient is zeroed -- the contrast genuinely reads the fit, not a constant", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B"], h5Wired: true });
  const h5Spec = family[4];

  // GREEN: a real, non-zero bias coefficient with a tight SE -- a clearly
  // non-zero, significant estimate.
  const realFit = judgeScoreDiagonalFit([5, 0.4, 0.9], [0.01, 0.01, 0.01]);
  const realResult = evaluateSpec(h5Spec, realFit);
  assert.equal(realResult.unimplemented, undefined);
  assert.ok(Math.abs(realResult.estimate - 0.9) < 1e-9, "estimate must equal the fit's own bias coefficient, not a hardcoded number");
  assert.ok(realResult.p < 0.01, "a large estimate with a tight SE must be far from p=1");

  // RED (mutation): zero out ONLY the bias coefficient in the SAME fit
  // shape -- if evaluateSpec() ever hardcoded H5's estimate/p instead of
  // reading fit.coefficients, this mutation would have no effect.
  const zeroedFit = judgeScoreDiagonalFit([5, 0.4, 0], [0.01, 0.01, 0.01]);
  const zeroedResult = evaluateSpec(h5Spec, zeroedFit);
  assert.equal(zeroedResult.estimate, 0, "zeroing the bias coefficient must zero H5's estimate");
  assert.ok(zeroedResult.p > 0.9, `expected p near 1 when the bias coefficient is exactly 0, got ${zeroedResult.p}`);

  // The two results must actually differ -- proving evaluateSpec() is
  // sensitive to the fit's coefficients, the RED/GREEN pair this test's
  // name promises.
  assert.notEqual(realResult.estimate, zeroedResult.estimate);
  assert.ok(realResult.p < zeroedResult.p);
});

test("H5 (wired) contrast targets ONLY the bias coefficient -- unrelated coefficients moving doesn't change H5's estimate", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B"], h5Wired: true });
  const h5Spec = family[4];
  const fitA = judgeScoreDiagonalFit([5, 0.4, 0.9], [0.01, 0.01, 0.01]);
  const fitB = judgeScoreDiagonalFit([50, 4.4, 0.9], [0.01, 0.01, 0.01]); // Intercept/judge_provider changed, bias term unchanged
  const resultA = evaluateSpec(h5Spec, fitA);
  const resultB = evaluateSpec(h5Spec, fitB);
  assert.equal(resultA.estimate, resultB.estimate);
});

test("buildRegisteredFamily: requires panelArms", () => {
  assert.throws(() => buildRegisteredFamily({ referenceArm: "A" }), /panelArms is required/);
});

// ── #46 QA SHOULD: panelArms duplicates are the unguarded sibling of the
//    reference-arm footgun -- h1Weights is keyed by coefficient name, so a
//    duplicate silently collapses while 1/panelArms.length does not. ──────

test("buildRegisteredFamily: refuses duplicate panelArms (the H1-weights-collapse footgun)", () => {
  assert.throws(
    () => buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "B", "D"] }),
    /duplicates/,
  );
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

// ── registeredFamilySlotCount() / applyHolmVerdicts(): the family is 5
//    SLOTS (H1+H2+H3+H4+H5=1 each -- H3's two sub-contrasts combine into one
//    IUT p-value, per docs/PREREGISTRATION.md:223's "5 registered
//    hypotheses"), and verdicts only exist after Holm correction over
//    exactly that many p-values (#46 QA MUST #1 + #2; QA re-review
//    BLOCKER 2). ──────────────────────────────────────────────────────────

test("registeredFamilySlotCount: 5 slots across 5 hypotheses (H3 is one IUT slot, not two)", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"] });
  assert.equal(registeredFamilySlotCount(family), 5);
});

test("registeredFamilySlotCount: independent of whether H5 is wired -- wiring it later does not change the count", () => {
  // H5 is always present as a stub (unimplemented) in the current family;
  // this pins that its slot is already counted, so implementing #45/B5
  // later cannot silently change m from what it already was.
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"] });
  assert.equal(family.find((f) => f.id === "H5").unimplemented, true);
  assert.equal(registeredFamilySlotCount(family), 5);
});

test("registeredFamilySlotCount: still 5 with opts.h5Wired: true, and H5 is no longer unimplemented (issue #80)", () => {
  // Wiring H5's fit must change ONLY whether its slot can reject, never how
  // many slots exist -- the exact property this issue's brief demands.
  const wired = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"], h5Wired: true });
  assert.equal(wired.find((f) => f.id === "H5").unimplemented, undefined);
  assert.equal(registeredFamilySlotCount(wired), 5);

  const unwired = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"] });
  assert.equal(registeredFamilySlotCount(unwired), registeredFamilySlotCount(wired), "wiring H5 must not change the family size relative to the unwired family");
});

test("applyHolmVerdicts: a raw-significant contrast becomes not-supported once Holm's step-down correction catches up to it", () => {
  // Regression for #46 QA MUST #1: H2/H3/H4 must consult the Holm-adjusted
  // p, not a raw CI/p, when deciding `supported`. H2's own raw p (0.01)
  // clears the raw one-sided 0.025 threshold comfortably -- but it is only
  // the family's SECOND-smallest p-value, so Holm's step-down running-max
  // (rank-1 multiplier, carrying forward rank-0's already-adjusted floor)
  // pushes its ADJUSTED p above threshold.
  //
  // This is a synthetic 5-slot family exercising applyHolmVerdicts()'s pure
  // step-down mechanics, not buildRegisteredFamily()'s actual output --
  // `kind` here is a placeholder string, not "one-sided-margin". Sized to 5
  // (H1..H5, one slot each -- see registeredFamilySlotCount()) so this stays
  // consistent with the real registered family and cannot be mistaken for
  // license to reintroduce H3's old 2-slot split (#46 QA re-review BLOCKER 2).
  const flat = [
    { id: "OTHER-SMALLEST", p: 0.0001, oneSided: true },
    { id: "H2", kind: "synthetic-one-sided", oneSided: true, p: 0.01 },
    { id: "OTHER-1", p: 0.9, oneSided: true },
    { id: "OTHER-2", p: 0.9, oneSided: true },
    { id: "OTHER-3", p: 0.9, oneSided: true },
  ];
  const familySize = 5;
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

// ── Issue #97: the registered family over an ARM SUBSET ────────────────────
// The registered contrasts name D/E/G/H. A store holding only A and B (the
// #8 smoke study) must produce a family that is EXPLICIT about what it
// cannot estimate, not one that dies four modules later as
// `contrastVector: unknown coefficient 'arm[T.E]'`. See contrasts.mjs's
// "ARM SUBSETS AND THE REGISTERED FAMILY" header for the decision.

test("#97: an A/B arm subset records H2/H3/H4 as NOT ESTIMABLE rather than emitting weights naming absent arms", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B"] });

  for (const id of ["H2", "H3", "H4"]) {
    const entry = family.find((f) => f.id === id);
    assert.equal(entry.notEstimable, true, `${id} must be recorded not-estimable under an A/B arm subset`);
    assert.equal(entry.weights, undefined, `${id} must NOT carry weights naming an arm the fit cannot have`);
    assert.equal(entry.components, undefined);
  }

  // The message must name the ARM, the FAMILY ENTRY, and the ARMS AVAILABLE
  // -- the whole point of the issue is that `unknown coefficient 'arm[T.E]'`
  // told an operator none of those three things.
  const h2 = family.find((f) => f.id === "H2");
  assert.deepEqual(h2.missingArms, ["E", "D"]);
  assert.deepEqual(h2.availableArms, ["A", "B"]);
  assert.match(h2.reason, /NOT ESTIMABLE/);
  assert.match(h2.reason, /H2/);
  assert.match(h2.reason, /\[E, D\]/);
  assert.match(h2.reason, /\[A, B\]/);

  // H4 is B >= D: B IS present, D is not -- only the genuinely absent arm
  // may be named, or the message misleads about which arm to go collect.
  const h4 = family.find((f) => f.id === "H4");
  assert.deepEqual(h4.missingArms, ["D"]);

  // H3's IUT baselines are D and H, both absent.
  assert.deepEqual(family.find((f) => f.id === "H3").missingArms, ["G", "D", "H"]);
});

test("#97: NO substitute arm is ever used -- a not-estimable entry's weights are absent, not re-pointed at a present arm", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B"] });
  const fit = { coefficients: [10, 3], coefficientNames: ["Intercept", "arm[T.B]"], vcov: [[0.01, 0], [0, 0.01]] };
  for (const id of ["H2", "H3", "H4"]) {
    const result = evaluateSpec(family.find((f) => f.id === id), fit);
    assert.equal(result.notEstimable, true);
    assert.equal(result.p, 1, "a not-estimable registered hypothesis cannot be rejected");
    assert.equal(result.estimate, undefined, `${id} must produce NO estimate -- an estimate here would be some OTHER arm's`);
  }
});

test("#97: a PARTIAL arm subset still estimates the entries whose arms are all present", () => {
  // B, D and E present: H2 (E vs D) and H4 (B vs D) are estimable; H3
  // (G vs D/H) is not. A blanket "any subset -> nothing estimable" fix
  // would fail this.
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E"] });
  assert.equal(family.find((f) => f.id === "H2").notEstimable, undefined);
  assert.equal(family.find((f) => f.id === "H4").notEstimable, undefined);
  assert.equal(family.find((f) => f.id === "H3").notEstimable, true);
  assert.deepEqual(family.find((f) => f.id === "H3").missingArms, ["G", "H"]);
});

test("#97: the full registered arm set is UNAFFECTED -- every entry stays estimable", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"] });
  for (const f of family) assert.equal(f.notEstimable, undefined, `${f.id} must stay estimable on the full grid`);
  assert.ok(family.find((f) => f.id === "H3").components.length === 2);
});

// H1's registered form is mean(panel arms) - A. Over ONE panel arm that is
// arithmetically (armX - A), a per-arm comparison that Appendix B item 5
// assigns to the §6.3 exploratory BH section and says is "never folded into
// the confirmatory Holm family". Computing it would put an exploratory
// contrast inside the Holm family under a registered hypothesis's name.
test("#97: H1 is NOT ESTIMABLE with a single panel arm (it would be a §6.3 exploratory per-arm contrast under H1's name)", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B"] });
  const h1 = family.find((f) => f.id === "H1");
  assert.equal(h1.notEstimable, true);
  assert.equal(h1.weights, undefined);
  assert.match(h1.reason, /per-arm/i);
  assert.match(h1.reason, /exploratory/i);
});

test("#97: H1 IS estimable with two or more panel arms", () => {
  const h1 = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D"] }).find((f) => f.id === "H1");
  assert.equal(h1.notEstimable, undefined);
  assert.equal(h1.weights["arm[T.B]"], 0.5);
});

// The belt behind buildRegisteredFamily()'s spec-time scoping: H1 is
// evaluated against the RAREFIED fit and H2-H4 against the FULL-POOL one
// (analysis.mjs), and those two fits' arm sets can differ, so a spec built
// against one arm set can still meet a fit built from another.
test("#97: evaluateSpec() records not-estimable when the FIT lacks an arm the spec names, instead of throwing 'unknown coefficient'", () => {
  // Built against the full arm set (so the spec really does carry weights),
  // then evaluated against a two-arm fit.
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"] });
  const twoArmFit = { coefficients: [10, 3], coefficientNames: ["Intercept", "arm[T.B]"], vcov: [[0.01, 0], [0, 0.01]] };

  const h2 = evaluateSpec(family.find((f) => f.id === "H2"), twoArmFit);
  assert.equal(h2.notEstimable, true);
  assert.equal(h2.p, 1);
  assert.deepEqual(h2.missingArms, ["E", "D"]);
  assert.deepEqual(h2.availableArms, ["B"], "the fit's own non-reference arms, read off its coefficient names");
  assert.match(h2.reason, /NOT ESTIMABLE/);

  // Same for an IUT spec, whose arms live on `components`, not `weights`.
  const h3 = evaluateSpec(family.find((f) => f.id === "H3"), twoArmFit);
  assert.equal(h3.notEstimable, true);
  assert.equal(h3.p, 1);
});

test("#97: the not-estimable belt is scoped to ARM coefficients -- a non-arm unknown name is still contrastVector()'s hard error", () => {
  // A typo'd or structurally-wrong coefficient name must NOT be quietly
  // absorbed as "not estimable": that is exactly the silent-drift the
  // contrastVector() guard exists to prevent.
  const spec = { id: "X", description: "typo", kind: "superiority", weights: { "totally_not_a_coefficient": 1 } };
  const fit = { coefficients: [10, 3], coefficientNames: ["Intercept", "arm[T.B]"], vcov: [[0.01, 0], [0, 0.01]] };
  assert.throws(() => evaluateSpec(spec, fit), /unknown coefficient/);
});

// ── Issue #97, the multiplicity half ───────────────────────────────────
test("#97: an arm subset does NOT shrink the registered family -- 5 slots, 5 entries, no drops", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B"] });
  assert.equal(family.length, 5, "a not-estimable entry is RECORDED, never dropped");
  assert.deepEqual(family.map((f) => f.id), ["H1", "H2", "H3", "H4", "H5"]);
  assert.equal(registeredFamilySlotCount(family), 5, "the Holm multiplier is the REGISTERED family size, not the estimated count");
});

test("#97: keeping m=5 over an arm subset is the CONSERVATIVE direction (never anti-conservative)", () => {
  // The AC's premise -- "correct as if it were 2 when only 2 were
  // estimable" -- points the wrong way. Holm's first step multiplies the
  // smallest p by m, so shrinking m makes rejection EASIER. Pin the
  // inequality so nobody "fixes" this into an FWER inflation.
  const withPlaceholders = holmBonferroni([0.004, 0.01, 1, 1, 1], { familySize: 5 });
  const shrunk = holmBonferroni([0.004, 0.01]);
  assert.ok(
    withPlaceholders[0] >= shrunk[0] && withPlaceholders[1] >= shrunk[1],
    `m=5 must adjust upward relative to m=2: ${JSON.stringify(withPlaceholders.slice(0, 2))} vs ${JSON.stringify(shrunk)}`,
  );
  assert.equal(withPlaceholders[0], 0.02); // 5 * 0.004
  assert.equal(shrunk[0], 0.008); // 2 * 0.004 -- the anti-conservative one
});

test("#97: familyEstimability() reports the loss WITHOUT feeding it back into the family size", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B"] });
  const fit = { coefficients: [10, 3], coefficientNames: ["Intercept", "arm[T.B]"], vcov: [[0.01, 0], [0, 0.01]] };
  const results = family.map((spec) => evaluateSpec(spec, fit));
  const estimability = familyEstimability(results);

  assert.equal(estimability.slots, 5, "slots is the registered count, always");
  assert.equal(estimability.estimated, 0, "A/B subset: H1-H4 not estimable, H5 unwired");
  assert.deepEqual(estimability.notEstimable.map((e) => e.id), ["H1", "H2", "H3", "H4"]);
  // H5 is unimplemented but NOT notEstimable -- "the judge-score fit did not
  // run" and "this run's arms cannot reach the contrast" are different
  // facts and must stay distinguishable.
  assert.ok(!estimability.notEstimable.some((e) => e.id === "H5"));

  // And the whole family still passes holmBonferroni()'s familySize gate.
  const holm = holmBonferroni(results.map((r) => r.p), { familySize: registeredFamilySlotCount(family) });
  assert.equal(holm.length, 5);
});
