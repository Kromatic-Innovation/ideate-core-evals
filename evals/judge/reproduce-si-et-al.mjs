// reproduce-si-et-al.mjs — the #16 real-data reproduction harness (issue #24).
//
// Reproduces Si et al.'s reported human-human split-half top/bottom-25%
// balanced accuracy (the registered 56.1% floor) from their REAL released
// reviews under data/si-et-al/. This is a MANUAL, opt-in tool — NOT a CI test:
// the payload is gitignored and never committed, so this cannot run hermetically
// and deliberately is not wired into `npm test`. It fails loud (via
// readSiEtAlSlice) when the slice is absent rather than falling back.
//
//   node evals/judge/reproduce-si-et-al.mjs [--splits N] [--seed S]
//
// Read docs/fetching-si-et-al.md first: the split is random (report the
// distribution, state the seed, do NOT tune), and the 337-vs-298 review-count
// discrepancy MUST be reconciled before any reproduced number is trusted.

import { readSiEtAlSlice } from "./slice.mjs";
import { balancedAccuracySplitHalf, SI_ET_AL_BALANCED_ACCURACY_FLOOR } from "./gate.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback;
}

const splits = arg("--splits", 1000);
const seed = arg("--seed", 1);

const slice = readSiEtAlSlice();
const ideaReviews = slice.ideas.map((idea) => idea.expertScores);

// Every idea must have >= 2 reviews to split into halves; report any that don't
// rather than silently dropping them.
const tooFew = slice.ideas.filter((idea) => idea.expertScores.length < 2);
if (tooFew.length > 0) {
  console.error(`WARNING: ${tooFew.length} idea(s) have <2 reviews and cannot be split — the construction requires >=2.`);
}

const { mean, values, n } = balancedAccuracySplitHalf({ ideaReviews, splits, seed });
const sorted = values.slice().sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

console.log(`Si et al. split-half top/bottom-25% balanced accuracy`);
console.log(`  ideas (n)            : ${n}`);
console.log(`  reviews (release)    : ${slice.reviewCount}  (paper reports 298 — reconcile before trusting; see docs/fetching-si-et-al.md)`);
for (const ex of slice.exclusions || []) {
  console.log(`  excluded condition   : ${ex.condition} (${ex.fileCount} files) — ${ex.reason}`);
}
console.log(`  splits               : ${splits}  seed: ${seed}`);
console.log(`  mean balanced acc    : ${mean.toFixed(4)}`);
console.log(`  distribution [p05..p95]: ${pct(0.05).toFixed(4)} .. ${pct(0.95).toFixed(4)}`);
console.log(`  registered floor     : ${SI_ET_AL_BALANCED_ACCURACY_FLOOR}  (56.1%)`);
console.log(
  mean >= SI_ET_AL_BALANCED_ACCURACY_FLOOR - 0.03 && mean <= SI_ET_AL_BALANCED_ACCURACY_FLOOR + 0.03
    ? `  => within ±3 points of 56.1% — consistent with the registered floor.`
    : `  => NOT within ±3 points of 56.1% — investigate (337-vs-298? score field? split?) before trusting the floor.`,
);
