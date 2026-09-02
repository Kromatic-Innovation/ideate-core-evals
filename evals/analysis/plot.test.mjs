import { test } from "node:test";
import assert from "node:assert/strict";
import { renderParetoSvg } from "./plot.mjs";

const POINTS = [
  { armId: "A", meanCostUsd: 0.5, meanResponse: 8, onFrontier: true },
  { armId: "B", meanCostUsd: 1.0, meanResponse: 12, onFrontier: true },
  { armId: "C", meanCostUsd: 1.5, meanResponse: 9, onFrontier: false },
];

test("renderParetoSvg: emits a well-formed <svg> document", () => {
  const svg = renderParetoSvg(POINTS);
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>\s*$/);
});

test("renderParetoSvg: every arm label appears in the output", () => {
  const svg = renderParetoSvg(POINTS);
  for (const p of POINTS) assert.ok(svg.includes(`>${p.armId}<`), `missing label for ${p.armId}`);
});

test("renderParetoSvg: escapes XML-sensitive characters in arm ids/titles", () => {
  const svg = renderParetoSvg([{ armId: "A&B<x>", meanCostUsd: 1, meanResponse: 1, onFrontier: true }], { title: "Cost <vs> Diversity" });
  assert.ok(!svg.includes("A&B<x>"));
  assert.ok(svg.includes("A&amp;B&lt;x&gt;"));
});

test("renderParetoSvg: rejects empty input", () => {
  assert.throws(() => renderParetoSvg([]), /non-empty/);
});
