import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAnalysisDataCsv, renderLme4FitR } from "./reproducibility.mjs";

const FRAME = {
  responseField: "distinct_k",
  rows: [
    { cellKey: "arm=A|brief=b1|rep=0|cfg=abc", armId: "A", briefId: "b1", replicate: 0, cfg: "abc", response: 10, costUsd: 0.5 },
    { cellKey: "arm=B|brief=b1|rep=0|cfg=abc", armId: "B", briefId: "b1", replicate: 0, cfg: "abc", response: 12, costUsd: 0.6 },
  ],
};

test("renderAnalysisDataCsv: header + one row per included cell", () => {
  const csv = renderAnalysisDataCsv(FRAME);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3); // header + 2 rows
  assert.equal(lines[0], "cellKey,arm,brief,replicate,cfg,distinct_k,costUsd");
  assert.match(lines[1], /^arm=A\|brief=b1\|rep=0\|cfg=abc,A,b1,0,abc,10,0.5$/);
});

test("renderAnalysisDataCsv: quotes/escapes fields containing commas or quotes", () => {
  const frame = { responseField: "distinct_k", rows: [{ cellKey: 'weird,"key', armId: "A", briefId: "b1", replicate: 0, cfg: "x", response: 1, costUsd: 0 }] };
  const csv = renderAnalysisDataCsv(frame);
  assert.match(csv, /"weird,""key"/);
});

test("renderLme4FitR: never executed, just generated text — embeds the actual response/formula/levels", () => {
  const r = renderLme4FitR({ responseField: "distinct_k", armLevels: ["A", "B", "D"], referenceArm: "A" });
  assert.match(r, /library\(lme4\)/);
  assert.match(r, /distinct_k ~ arm \+ \(1 \| brief\) \+ \(1 \| brief:arm\)/);
  assert.match(r, /relevel\(data\$arm, ref = "A"\)/);
  assert.match(r, /c\("A", "B", "D"\)/);
});

// — dataFile (issue #73 fix round, BLOCKING) —————————————————————————————
// A rarefied-lane script that reads the full-pool CSV would silently
// reproduce the wrong estimand under H1's label (analysis.mjs writes BOTH
// lme4-fit.R and lme4-fit-rarefied.R from this same renderer). These tests
// pin the parameter that stops that from recurring.

test("renderLme4FitR: dataFile defaults to analysis-data.csv -- every caller that predates the rarefied lane is unaffected", () => {
  const r = renderLme4FitR({ responseField: "distinct_k", armLevels: ["A", "B"], referenceArm: "A" });
  assert.match(r, /read\.csv\("analysis-data\.csv"\)/);
});

test("renderLme4FitR: an explicit dataFile is what the generated script actually reads, not a hardcoded default", () => {
  const r = renderLme4FitR({ responseField: "distinct_k_rarefied", armLevels: ["A", "B"], referenceArm: "A", dataFile: "analysis-data-rarefied.csv" });
  assert.match(r, /read\.csv\("analysis-data-rarefied\.csv"\)/);
  assert.doesNotMatch(r, /read\.csv\("analysis-data\.csv"\)/);
  assert.match(r, /distinct_k_rarefied ~ arm/);
});

test("renderLme4FitR: a full-pool script and a rarefied script rendered from the SAME armLevels/referenceArm still differ -- distinguishable by dataFile/responseField, not accidentally identical", () => {
  const full = renderLme4FitR({ responseField: "distinct_k", armLevels: ["A", "B"], referenceArm: "A" });
  const rarefied = renderLme4FitR({ responseField: "distinct_k_rarefied", armLevels: ["A", "B"], referenceArm: "A", dataFile: "analysis-data-rarefied.csv" });
  assert.notEqual(full, rarefied, "a rarefied-lane script must not be byte-identical to the full-pool script it sits alongside");
});
