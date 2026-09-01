// reproduce-si-et-al.mjs — human-human split-half balanced accuracy on OUR
// 98-idea slice (issue #47, split out of #16/#24).
//
// This is NOT a reproduction of Si et al.'s reported 56.1% — that figure is
// computed over a different population (147 ideas / 3 conditions / 337
// reviews) using a different split rule (random halves of each idea's
// REVIEWERS, tracked by a reviewer id the anonymized release does not ship).
// Our slice is 98 ideas / 2 conditions (Human + AI; AI_Rerank excluded) / 228
// reviews, and our split is random halves of each idea's REVIEWS (there is no
// reviewer id to split by — see docs/fetching-si-et-al.md). 56.1% is a
// PAPER-REPORTED COMPARATOR from a different population and a different split
// scheme — never claim it is reproduced here.
//
// This is a MANUAL, opt-in tool — NOT a CI test: the payload is gitignored and
// never committed, so this cannot run hermetically and deliberately is not
// wired into `npm test`. It fails loud (via readSiEtAlSlice) when the slice is
// absent rather than falling back.
//
//   node evals/judge/reproduce-si-et-al.mjs [--splits N] [--seed S]
//                                            [--bootstrap-draws N] [--bootstrap-seed S]
//
// ── REGISTERED CONSTRUCTION (closed before this ever ran; issue #47) ────────
// These choices are the one degree of freedom this measurement gets. They are
// fixed here, in this comment, BEFORE any number below was computed, and MUST
// NOT be revisited after seeing this output or any judge score. If a future
// change is genuinely warranted, it is a new registration (a new issue), not a
// silent edit of these defaults.
//   score column     : overall_score            (DEFAULT_SCORE_FIELD, slice.mjs)
//   quantile          : 0.25                      (DEFAULT_QUANTILE, gate.mjs)
//   split rule        : split-half of each idea's own REVIEWS (not reviewers —
//                        no reviewer id exists in the anonymized release)
//   split seed        : 1     split count : 1000   (point distribution)
//   bootstrap seed     : 2     bootstrap draws : 2000  (idea-resampling CI)
//   bootstrap splits/draw : 200  (averaged per resample -- see bootstrapSplitsPerDraw
//                        below; the reported point estimate is itself a mean over
//                        `splits` draws, so the bootstrap must resample that same
//                        mean statistic, not a single split, to be a valid CI for it)
//   exclusions         : AI_Rerank (DEFAULT_EXCLUDED_CONDITIONS, slice.mjs)
//
// ── Why a bootstrap CI, not a point estimate ─────────────────────────────────
// 105 of the 147 released ideas (most of our 98) carry exactly 2 reviews, so a
// split-half on those is one reviewer's mean against the other's — a single
// coin-flip-sized comparison per idea. The `--splits` distribution above
// already reports the resulting variance from the RANDOM SPLIT itself, but it
// still conditions on the same 98 ideas every time. The bootstrap below
// resamples IDEAS with replacement (the sampling unit that would differ if we
// had drawn a different 98-idea slice) and reports the resulting distribution
// as a percentile CI — this is what should be quoted, not the raw mean alone.

import { readSiEtAlSlice } from "./slice.mjs";
import {
  balancedAccuracySplitHalf,
  SI_ET_AL_BALANCED_ACCURACY_FLOOR,
} from "./gate.mjs";
import {
  SI_ET_AL_LLM_COMPARATOR_DIRECT,
  SI_ET_AL_LLM_COMPARATOR_PAIRWISE,
} from "./config.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback;
}

const splits = arg("--splits", 1000);
const seed = arg("--seed", 1);
const bootstrapDraws = arg("--bootstrap-draws", 2000);
const bootstrapSeed = arg("--bootstrap-seed", 2);
// Splits averaged PER bootstrap resample. Fixes a CI-inflation bug: the
// reported point estimate is a MEAN over `splits` draws (default 1000), but
// each bootstrap resample used to call balancedAccuracySplitHalf with
// splits:1 -- that measures Var(single-split-on-resample), which is
// Var_idea(E[stat]) + E[Var_split], strictly WIDER than the sampling
// variance of the reported mean statistic. Averaging S>=100 splits per
// resample instead estimates the sampling variance of the MEAN, matching
// what's actually reported. S=200 chosen: 2000 draws x 200 splits = 400,000
// split computations, tractable in-process (single run, not CI-gated).
const bootstrapSplitsPerDraw = arg("--bootstrap-splits-per-draw", 200);

// Local PRNG for idea-resampling only — deliberately separate from gate.mjs's
// internal mulberry32 (which drives the within-idea review split and is not
// exported). Same algorithm, different concern: this one resamples IDEAS,
// gate.mjs's drives which REVIEWS land in which half.
function mulberry32(s) {
  let a = s >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slice = readSiEtAlSlice();
const ideaReviews = slice.ideas.map((idea) => idea.expertScores);
const includedReviewCount = ideaReviews.reduce((sum, r) => sum + r.length, 0);

// Every idea must have >= 2 reviews to split into halves; report any that don't
// rather than silently dropping them.
const tooFew = slice.ideas.filter((idea) => idea.expertScores.length < 2);
if (tooFew.length > 0) {
  console.error(`WARNING: ${tooFew.length} idea(s) have <2 reviews and cannot be split — the construction requires >=2.`);
}

// ── Point distribution: repeated random within-idea review splits ───────────
const { mean, values, n } = balancedAccuracySplitHalf({ ideaReviews, splits, seed });
const sorted = values.slice().sort((a, b) => a - b);
// Symmetric percentile index: floor for the lower tail, ceil-1 for the upper
// tail (matches evals/analysis/pareto.mjs's costDiversityRatio CI form).
// A single floor() for both tails is off by ~1 order statistic on the upper
// tail relative to the lower -- e.g. p=0.05 and p=0.95 on n=100 give indices
// 5 and 95 (floor), not the symmetric 5 and 94.
const pct = (arr, p) => {
  const idx = p <= 0.5 ? Math.floor(p * arr.length) : Math.ceil(p * arr.length) - 1;
  return arr[Math.max(0, Math.min(arr.length - 1, idx))];
};

// ── Bootstrap CI: resample ideas with replacement, averaging bootstrapSplitsPerDraw split-half draws each ──
const bootRand = mulberry32(bootstrapSeed);
const bootValues = new Array(bootstrapDraws);
for (let b = 0; b < bootstrapDraws; b++) {
  const resampled = new Array(n);
  for (let i = 0; i < n; i++) resampled[i] = ideaReviews[Math.floor(bootRand() * n)];
  // Average bootstrapSplitsPerDraw split-half draws per bootstrap resample --
  // the reported point estimate is itself a mean over `splits` draws, so the
  // bootstrap must estimate the sampling variance of THAT mean, not of a
  // single split (see header comment on bootstrapSplitsPerDraw above).
  const { mean: resampledMean } = balancedAccuracySplitHalf({
    ideaReviews: resampled,
    splits: bootstrapSplitsPerDraw,
    seed: bootstrapSeed * 1_000_003 + b + 1,
  });
  bootValues[b] = resampledMean;
}
const bootSorted = bootValues.slice().sort((a, b) => a - b);
const ciLo = pct(bootSorted, 0.025);
const ciHi = pct(bootSorted, 0.975);

const overlapsFloor = ciLo <= SI_ET_AL_BALANCED_ACCURACY_FLOOR && ciHi >= SI_ET_AL_BALANCED_ACCURACY_FLOOR;
const excludesChance = ciLo > 0.5;

console.log(`Human-human split-half top/bottom-25% balanced accuracy — OUR 98-idea slice (issue #47)`);
console.log(`  ideas (n)                : ${n}  (Human + AI; AI_Rerank excluded)`);
console.log(`  reviews (our slice)      : ${includedReviewCount}`);
console.log(`  reviews (full release)   : ${slice.reviewCount}  (all 3 conditions, incl. excluded AI_Rerank)`);
for (const ex of slice.exclusions || []) {
  console.log(`  excluded condition       : ${ex.condition} (${ex.fileCount} files) — ${ex.reason}`);
}
console.log(`  split seed / count       : ${seed} / ${splits}`);
console.log(`  bootstrap seed / draws   : ${bootstrapSeed} / ${bootstrapDraws}  (resamples IDEAS with replacement)`);
console.log(`  bootstrap splits/draw    : ${bootstrapSplitsPerDraw}  (averaged per resample, matching the reported mean's construction)`);
console.log(`  mean balanced acc        : ${mean.toFixed(4)}`);
console.log(`  split distribution p05-p95: ${pct(sorted, 0.05).toFixed(4)} .. ${pct(sorted, 0.95).toFixed(4)}`);
console.log(`  bootstrap 95% CI         : ${ciLo.toFixed(4)} .. ${ciHi.toFixed(4)}`);
console.log("");
console.log(`  Comparators (Si et al. 2024, Table 11 — 147 ideas / 3 conditions / 337 reviews, reviewer split-half):`);
console.log(`    paper-reported human-human (floor)    : ${SI_ET_AL_BALANCED_ACCURACY_FLOOR}  — paper-reported, different population and different split scheme; NOT reproduced here`);
console.log(`    Claude-3.5 Direct (shape-matched)      : ${SI_ET_AL_LLM_COMPARATOR_DIRECT}`);
console.log(`    Claude-3.5 Pairwise (their best LLM)   : ${SI_ET_AL_LLM_COMPARATOR_PAIRWISE}`);
console.log("");
console.log(`  => 95% CI ${overlapsFloor ? "OVERLAPS" : "does NOT overlap"} the registered floor (${SI_ET_AL_BALANCED_ACCURACY_FLOOR}).`);
console.log(`  => 95% CI ${excludesChance ? "EXCLUDES" : "does NOT exclude"} chance (0.50).`);

// ── Durable, machine-readable output for #44's Appendix B ───────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outPath = path.join(__dirname, "..", "..", "docs", "si-et-al-human-human-floor.json");
const record = {
  kind: "si-et-al-human-human-recomputation",
  issue: 47,
  computedAt: new Date().toISOString(),
  slice: {
    n,
    conditions: ["Human", "AI"],
    exclusions: (slice.exclusions || []).map((ex) => ({ condition: ex.condition, fileCount: ex.fileCount, reason: ex.reason })),
    reviewsIncluded: includedReviewCount,
    reviewsFullRelease: slice.reviewCount,
  },
  construction: {
    scoreColumn: "overall_score",
    quantile: 0.25,
    splitRule: "split-half of each idea's own reviews (no reviewer id in the anonymized release)",
    splitSeed: seed,
    splitCount: splits,
    bootstrapSeed,
    bootstrapDraws,
    bootstrapSplitsPerDraw,
  },
  result: {
    mean,
    splitDistributionP05: pct(sorted, 0.05),
    splitDistributionP95: pct(sorted, 0.95),
    bootstrapCi95: [ciLo, ciHi],
    overlapsRegisteredFloor: overlapsFloor,
    excludesChance,
  },
  comparators: {
    paperReportedHumanHumanFloor: {
      value: SI_ET_AL_BALANCED_ACCURACY_FLOOR,
      label: "paper-reported, different population and different split scheme (Si et al. 2024 Table 11: 147 ideas / 3 conditions / 337 reviews, reviewer split-half) — never 'reproduced'",
    },
    claude35DirectShapeMatched: { value: SI_ET_AL_LLM_COMPARATOR_DIRECT, label: "Si et al. Table 11, same paper population" },
    claude35Pairwise: { value: SI_ET_AL_LLM_COMPARATOR_PAIRWISE, label: "Si et al. Table 11, same paper population, their best LLM evaluator of any shape" },
  },
};
fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
console.log("");
console.log(`  Wrote ${outPath}`);
