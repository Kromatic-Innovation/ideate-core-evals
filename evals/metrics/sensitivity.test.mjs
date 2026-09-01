// sensitivity.test.mjs — hermetic tests for the ±0.05 sensitivity-analysis
// capability. Uses the committed MiniLM fixture embedder only — never the
// network. See sensitivity.mjs header for the H1–H4 scope boundary this
// module deliberately does not cross.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { poolSensitivityReport, sensitivityReportForPools, bandAsFractionOfGap, SENSITIVITY_BAND } from "./sensitivity.mjs";
import { CLUSTER_DISTANCE_THRESHOLD } from "./calibration.mjs";
import { fixtureEmbedder } from "./embedder.mjs";
import { DUPLICATE_POOL, RANDOM_TEXT_POOL } from "./fixtures/control-texts.mjs";

const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/embeddings.json", import.meta.url), "utf8"));
const embedder = fixtureEmbedder(FIXTURES);

test("poolSensitivityReport reports distinctK at threshold-band/threshold/threshold+band plus poolDiversity", async () => {
  const vecs = await embedder.embed(RANDOM_TEXT_POOL);
  const report = poolSensitivityReport(vecs, CLUSTER_DISTANCE_THRESHOLD);
  assert.equal(report.threshold, CLUSTER_DISTANCE_THRESHOLD);
  assert.equal(report.atLow.threshold, CLUSTER_DISTANCE_THRESHOLD - SENSITIVITY_BAND);
  assert.equal(report.atHigh.threshold, CLUSTER_DISTANCE_THRESHOLD + SENSITIVITY_BAND);
  assert.ok(Number.isInteger(report.atLow.distinctK));
  assert.ok(Number.isInteger(report.atBase.distinctK));
  assert.ok(Number.isInteger(report.atHigh.distinctK));
  // A lower threshold merges less readily -> distinctK never decreases as
  // threshold decreases (weakly monotonic in threshold).
  assert.ok(report.atLow.distinctK >= report.atBase.distinctK);
  assert.ok(report.atBase.distinctK >= report.atHigh.distinctK);
  // Threshold-free companion metric is present and independent of the band.
  assert.ok(Number.isFinite(report.poolDiversity));
});

test("poolSensitivityReport clamps the low threshold at 0 rather than going negative", async () => {
  const vecs = await embedder.embed(DUPLICATE_POOL);
  const report = poolSensitivityReport(vecs, 0.02, 0.05);
  assert.equal(report.atLow.threshold, 0);
});

test("poolSensitivityReport rejects a negative base threshold or band", async () => {
  const vecs = await embedder.embed(DUPLICATE_POOL);
  assert.throws(() => poolSensitivityReport(vecs, -0.1), /non-negative/);
  assert.throws(() => poolSensitivityReport(vecs, 0.1, -0.05), /non-negative/);
});

test("sensitivityReportForPools reports one entry per named pool", async () => {
  const [dupVecs, randVecs] = await Promise.all([embedder.embed(DUPLICATE_POOL), embedder.embed(RANDOM_TEXT_POOL)]);
  const reports = sensitivityReportForPools({ duplicate: dupVecs, random: randVecs }, CLUSTER_DISTANCE_THRESHOLD);
  assert.deepEqual(Object.keys(reports).sort(), ["duplicate", "random"]);
  assert.equal(reports.duplicate.atBase.distinctK, 1);
});

test("bandAsFractionOfGap expresses the band relative to an observed same/different gap", () => {
  assert.equal(bandAsFractionOfGap(0.5), SENSITIVITY_BAND / 0.5);
  // A tiny gap (e.g. Voyage's compressed space) makes the same absolute band
  // a much larger fraction -- exactly the diagnostic this function exists for.
  assert.ok(bandAsFractionOfGap(0.1) > bandAsFractionOfGap(1.0));
});

test("bandAsFractionOfGap rejects a non-positive gap", () => {
  assert.throws(() => bandAsFractionOfGap(0), /positive/);
  assert.throws(() => bandAsFractionOfGap(-0.1), /positive/);
});
