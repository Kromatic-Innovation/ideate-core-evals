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
      {
        id: "H3",
        description: "G > max(D, H) -- IUT",
        kind: "iut-max-p",
        oneSided: true,
        estimate: -0.5,
        ci: [-1.2, 0.2],
        p: 0.2,
        holmP: 0.2,
        supported: false,
        components: [
          { id: "H3:G-D", oneSided: true, estimate: 1.0, ci: [0.1, 1.9], p: 0.03 },
          { id: "H3:G-H", oneSided: true, estimate: -0.5, ci: [-1.2, 0.2], p: 0.2 },
        ],
      },
    ],
    holmAdjusted: [0.02, 0.2],
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

test("renderReport: registered hypotheses table lists one ROW per hypothesis (H3 is a single IUT row/verdict, not two)", () => {
  const md = renderReport(baseInput());
  assert.match(md, /\| H1 \|/);
  // exactly one H3 table row (one leading "| H3 |" cell) -- the row count is
  // what BLOCKER 2 fixed (one Holm slot, one verdict), not whether the
  // underlying component estimates are visible (§6.2: effect sizes are the
  // headline, not p-values) -- both component estimates/CIs are still
  // rendered inside that single row's cells.
  const h3Rows = md.split("\n").filter((line) => /^\| H3 \|/.test(line));
  assert.equal(h3Rows.length, 1, `expected exactly one H3 row, got ${h3Rows.length}`);
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
    { id: "H2", description: "E >= D", kind: "one-sided-margin", oneSided: true, estimate: 1.0, ci: [0.2, 1.8], p: 0.001, holmP: 0.5, supported: false },
  ];
  input.holmAdjusted = [0.5];
  const md = renderReport(input);
  assert.match(md, /not supported/);
  assert.doesNotMatch(md, /\| supported \|/);
});

test("renderReport: verdict is keyed off r.oneSided, not r.kind (regression for #46 QA SHOULD)", () => {
  // A hypothetical future two-sided hypothesis with a kind other than
  // "superiority" must still read `significant`, not `supported` -- keying
  // off r.kind (as before) would silently misread this as "not supported".
  const input = baseInput();
  input.registeredResults = [
    { id: "HX", description: "some future two-sided hypothesis", kind: "some-other-kind", estimate: 1.0, ci: [0.2, 1.8], p: 0.001, holmP: 0.01, significant: true },
  ];
  input.holmAdjusted = [0.01];
  const md = renderReport(input);
  assert.match(md, /\| significant \|/);
});

test("renderReport: an unimplemented H5 entry renders without throwing", () => {
  const input = baseInput();
  input.registeredResults.push({ id: "H5", unimplemented: true });
  const md = renderReport(input);
  assert.match(md, /unimplemented/);
});
