import { test } from "node:test";
import assert from "node:assert/strict";
import { paretoFrontier, costDiversityRatio, costDiversityRatioByArm } from "./pareto.mjs";

test("paretoFrontier: a strictly dominated point is excluded", () => {
  const arms = [
    { armId: "cheap-good", meanCostUsd: 1, meanResponse: 10 },
    { armId: "dominated", meanCostUsd: 2, meanResponse: 5 }, // costs more, worse response than cheap-good
  ];
  const out = paretoFrontier(arms);
  assert.equal(out.find((a) => a.armId === "cheap-good").onFrontier, true);
  assert.equal(out.find((a) => a.armId === "dominated").onFrontier, false);
});

test("paretoFrontier: a genuine tradeoff keeps both points on the frontier", () => {
  const arms = [
    { armId: "cheap", meanCostUsd: 1, meanResponse: 5 },
    { armId: "expensive-better", meanCostUsd: 3, meanResponse: 10 },
  ];
  const out = paretoFrontier(arms);
  assert.ok(out.every((a) => a.onFrontier));
});

test("paretoFrontier: rejects empty input", () => {
  assert.throws(() => paretoFrontier([]), /non-empty/);
});

test("costDiversityRatio: pooled ratio is total response over total cost", () => {
  const rows = [
    { briefId: "b1", response: 10, costUsd: 1 },
    { briefId: "b2", response: 20, costUsd: 2 },
  ];
  const r = costDiversityRatio(rows, { iterations: 100, seed: 42 });
  assert.equal(r.ratio, 30 / 3);
  assert.equal(r.descriptive, true);
  assert.ok(r.ciLower <= r.ratio && r.ratio <= r.ciUpper);
});

test("costDiversityRatio: is deterministic given the same seed", () => {
  const rows = [
    { briefId: "b1", response: 10, costUsd: 1 },
    { briefId: "b2", response: 15, costUsd: 1.5 },
    { briefId: "b3", response: 8, costUsd: 0.9 },
  ];
  const a = costDiversityRatio(rows, { iterations: 500, seed: 7 });
  const b = costDiversityRatio(rows, { iterations: 500, seed: 7 });
  assert.deepEqual(a, b);
});

test("costDiversityRatio: different seeds may give different CIs but same point estimate", () => {
  const rows = [
    { briefId: "b1", response: 10, costUsd: 1 },
    { briefId: "b2", response: 15, costUsd: 1.5 },
    { briefId: "b3", response: 8, costUsd: 0.9 },
  ];
  const a = costDiversityRatio(rows, { iterations: 500, seed: 1 });
  const b = costDiversityRatio(rows, { iterations: 500, seed: 2 });
  assert.equal(a.ratio, b.ratio);
});

test("costDiversityRatioByArm: keys the result by armId", () => {
  const frame = {
    rows: [
      { armId: "A", briefId: "b1", response: 10, costUsd: 1 },
      { armId: "A", briefId: "b2", response: 12, costUsd: 1 },
      { armId: "B", briefId: "b1", response: 20, costUsd: 2 },
      { armId: "B", briefId: "b2", response: 18, costUsd: 2 },
    ],
  };
  const out = costDiversityRatioByArm(frame, { iterations: 50 });
  assert.deepEqual(Object.keys(out).sort(), ["A", "B"]);
  assert.equal(out.A.ratio, 22 / 2);
  assert.equal(out.B.ratio, 38 / 4);
});
