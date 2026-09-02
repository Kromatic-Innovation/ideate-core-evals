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
