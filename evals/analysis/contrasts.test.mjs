import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastVector, armCoefficientName, evaluateContrast, buildRegisteredFamily, evaluateSpec } from "./contrasts.mjs";

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

test("buildRegisteredFamily: H2 with delta yields a non-inferiority verdict", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E"], delta: 0.5 });
  const fit = diagonalFit([10, 1, 2, 3, 4, 5], [0.1, 0.01, 0.01, 0.01, 0.01, 0.01]);
  const h2 = evaluateSpec(family[1], fit); // E - D = 3 - 2 = 1, se small -> CI lower bound well above -0.5
  assert.equal(h2.deltaUnregistered, undefined);
  assert.equal(h2.supported, true);
});

test("buildRegisteredFamily: H3 expands to two subcontrasts, both must exceed 0 to be supported", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"], h3TargetVsBest: ["G", "D", "H"] });
  const h3 = family[2];
  assert.equal(h3.subcontrasts.length, 2);
  assert.deepEqual(h3.subcontrasts.map((s) => s.id), ["H3:G-D", "H3:G-H"]);

  // G (index 4, coeff 4) clearly beats both D (2) and H (5)? no -- G=4 < H=5,
  // so this fixture should NOT be jointly supported (G-H is negative).
  const fit = diagonalFit([10, 1, 2, 3, 4, 5], [0.1, 0.001, 0.001, 0.001, 0.001, 0.001]);
  const results = evaluateSpec(h3, fit);
  assert.equal(results.length, 2);
  const gMinusD = results.find((r) => r.id === "H3:G-D");
  const gMinusH = results.find((r) => r.id === "H3:G-H");
  assert.equal(gMinusD.supported, true); // 4 - 2 = 2 > 0
  assert.equal(gMinusH.supported, false); // 4 - 5 = -1 < 0
});

test("buildRegisteredFamily: H5 is a named stub, evaluated as unimplemented", () => {
  const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B"] });
  const h5 = evaluateSpec(family[4], diagonalFit([1, 1], [1, 1]));
  assert.equal(h5.unimplemented, true);
});

test("buildRegisteredFamily: requires panelArms", () => {
  assert.throws(() => buildRegisteredFamily({ referenceArm: "A" }), /panelArms is required/);
});
