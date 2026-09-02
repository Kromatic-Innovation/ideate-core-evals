import { test } from "node:test";
import assert from "node:assert/strict";
import { balancedAnovaOracle } from "./anova-oracle.mjs";

// Deterministic synthetic balanced grid (no RNG — pure arithmetic fixtures
// so the identities below are exact, not merely approximate).
function buildGrid({ armLevels, briefLevels, r, armEffect, briefEffect, interactionEffect, residual }) {
  const rows = [];
  for (const arm of armLevels) {
    for (const brief of briefLevels) {
      for (let rep = 0; rep < r; rep++) {
        const y =
          10 +
          armEffect(arm) +
          briefEffect(brief) +
          interactionEffect(arm, brief) +
          residual(arm, brief, rep);
        rows.push({ armId: arm, briefId: brief, response: y });
      }
    }
  }
  return rows;
}

const ARMS = ["A", "B", "D"];
const BRIEFS = ["b1", "b2", "b3", "b4"];

test("balancedAnovaOracle: sum of squares decomposition is an exact identity", () => {
  // A small deterministic residual pattern (not all zero) so ssE > 0.
  const residualPattern = [0.1, -0.1, 0.2];
  const rows = buildGrid({
    armLevels: ARMS,
    briefLevels: BRIEFS,
    r: 3,
    armEffect: (arm) => ({ A: 0, B: 2, D: 4 })[arm],
    briefEffect: (brief) => ({ b1: 0, b2: 1, b3: -1, b4: 0.5 })[brief],
    interactionEffect: () => 0,
    residual: (arm, brief, rep) => residualPattern[rep],
  });
  const oracle = balancedAnovaOracle(rows, ARMS, BRIEFS);

  const grandMean = rows.reduce((s, r0) => s + r0.response, 0) / rows.length;
  const ssTotal = rows.reduce((s, r0) => s + (r0.response - grandMean) ** 2, 0);
  const ssA = oracle.msA * (ARMS.length - 1);
  const ssB = oracle.msB * (BRIEFS.length - 1);
  const ssAB = oracle.msAB * (ARMS.length - 1) * (BRIEFS.length - 1);
  const ssE = oracle.msE * ARMS.length * BRIEFS.length * (3 - 1);

  assert.ok(Math.abs(ssA + ssB + ssAB + ssE - ssTotal) < 1e-9, "SS_A + SS_B + SS_AB + SS_E must equal SS_total exactly (identity, not approximation)");
});

test("balancedAnovaOracle: recovers the true arm effect in the arm means (zero interaction/residual)", () => {
  const rows = buildGrid({
    armLevels: ARMS,
    briefLevels: BRIEFS,
    r: 2,
    armEffect: (arm) => ({ A: 0, B: 2, D: 4 })[arm],
    briefEffect: (brief) => ({ b1: 0, b2: 1, b3: -1, b4: 0.5 })[brief],
    interactionEffect: () => 0,
    residual: () => 0,
  });
  const oracle = balancedAnovaOracle(rows, ARMS, BRIEFS);
  assert.ok(Math.abs(oracle.armMeans.B - oracle.armMeans.A - 2) < 1e-9);
  assert.ok(Math.abs(oracle.armMeans.D - oracle.armMeans.A - 4) < 1e-9);
  assert.equal(oracle.sigmaAB2, 0);
  assert.equal(oracle.sigmaE2, 0);
});

test("balancedAnovaOracle: armContrastSE uses MS_AB, not MS_E (they differ here)", () => {
  const rows = buildGrid({
    armLevels: ARMS,
    briefLevels: BRIEFS,
    r: 3,
    armEffect: (arm) => ({ A: 0, B: 2, D: 4 })[arm],
    briefEffect: () => 0,
    interactionEffect: (arm, brief) => (arm === "B" && brief === "b2" ? 1.5 : 0), // real interaction -> MS_AB > MS_E
    residual: (arm, brief, rep) => [0.05, -0.05, 0][rep],
  });
  const oracle = balancedAnovaOracle(rows, ARMS, BRIEFS);
  assert.ok(oracle.msAB > oracle.msE, "fixture must produce a genuine interaction so MS_AB != MS_E");
  const seViaAB = Math.sqrt((2 * oracle.msAB) / (BRIEFS.length * 3));
  const seViaE = Math.sqrt((2 * oracle.msE) / (BRIEFS.length * 3));
  assert.equal(oracle.armContrastSE("A", "B"), seViaAB);
  assert.notEqual(seViaAB, seViaE);
});

test("balancedAnovaOracle: throws on an incomplete (unbalanced) design", () => {
  const rows = buildGrid({ armLevels: ARMS, briefLevels: BRIEFS, r: 2, armEffect: () => 0, briefEffect: () => 0, interactionEffect: () => 0, residual: () => 0 });
  rows.pop(); // remove one row -> one cell now has fewer replicates
  assert.throws(() => balancedAnovaOracle(rows, ARMS, BRIEFS), /not balanced/);
});
