import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport } from "./report.mjs";

function baseInput() {
  return {
    frame: {
      responseField: "distinct_k",
      configHash: "cfg123",
      failuresByArm: { A: { parse_failure: 2 } },
      skippedByArm: { B: 1 },
      excluded: { stale: [{ key: "arm=A|brief=b1|rep=0|cfg=old" }] },
    },
    ladder: { rung: "R0", history: [{ rung: "R0", descended: false }] },
    registeredResults: [
      { id: "H1", description: "mean(panel) - A", kind: "superiority", estimate: 2.1, ci: [0.5, 3.7], p: 0.01, holmP: 0.02, significant: true },
      [
        { id: "H3:G-D", kind: "pairwise-max", oneSided: true, estimate: 1.0, ci: [0.1, 1.9], p: 0.03, holmP: 0.06, supported: true },
        { id: "H3:G-H", kind: "pairwise-max", oneSided: true, estimate: -0.5, ci: [-1.2, 0.2], p: 0.2, holmP: 0.2, supported: false },
      ],
    ],
    holmAdjusted: [0.02, 0.06, 0.2],
    paretoPoints: [{ armId: "A", meanCostUsd: 0.5, meanResponse: 8, onFrontier: true }],
    costRatioByArm: { A: { ratio: 16, ciLower: 12, ciUpper: 20 } },
    analysisHash: "hash456",
  };
}

test("renderReport: includes configHash and analysisHash", () => {
  const md = renderReport(baseInput());
  assert.match(md, /cfg123/);
  assert.match(md, /hash456/);
});

test("renderReport: names the rung reached", () => {
  const md = renderReport(baseInput());
  assert.match(md, /rung \*\*R0\*\*/);
});

test("renderReport: an R3 rung is explicitly labeled descriptive-only", () => {
  const input = baseInput();
  input.ladder = { rung: "R3", history: [] };
  const md = renderReport(input);
  assert.match(md, /no confirmatory inference/i);
});

test("renderReport: registered hypotheses table lists every flattened entry (H3 expands to 2)", () => {
  const md = renderReport(baseInput());
  assert.match(md, /H1/);
  assert.match(md, /H3:G-D/);
  assert.match(md, /H3:G-H/);
});

test("renderReport: never silently drops failure/skip counts (§6.3)", () => {
  const md = renderReport(baseInput());
  assert.match(md, /parse_failure: 2/);
  assert.match(md, /stale cell/);
});

test("renderReport: cost lane is labeled descriptive, includes CI", () => {
  const md = renderReport(baseInput());
  assert.match(md, /descriptive/i);
  assert.match(md, /16\.000/);
});

test("renderReport: verdict reads the Holm-adjusted result, not a raw CI/p (regression for #46 QA MUST #1)", () => {
  const input = baseInput();
  // A raw CI/p that WOULD look supported (ci[0] > 0, p < 0.05) but whose
  // Holm-adjusted p (holmP) is above threshold and supported:false, as
  // applyHolmVerdicts() would actually produce after multiplicity
  // correction wipes out the raw significance.
  input.registeredResults = [
    { id: "H2", description: "E >= D", kind: "non-inferiority", oneSided: true, estimate: 1.0, ci: [0.2, 1.8], p: 0.001, holmP: 0.5, supported: false },
  ];
  input.holmAdjusted = [0.5];
  const md = renderReport(input);
  assert.match(md, /not supported/);
  assert.doesNotMatch(md, /\| supported \|/);
});

test("renderReport: an unimplemented H5 entry renders without throwing", () => {
  const input = baseInput();
  input.registeredResults.push({ id: "H5", unimplemented: true });
  const md = renderReport(input);
  assert.match(md, /unimplemented/);
});
