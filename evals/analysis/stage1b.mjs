#!/usr/bin/env node
// Stage 1b's registered two-contrast family (docs/PREREGISTRATION.md Appendix I
// item 4, sized by Appendix J item 5, transport by Appendix K).
//
// WHY THIS FILE EXISTS: analysis.mjs fits the §6.1 registered family H1-H5, and
// Stage 1b cannot estimate any of them -- its arms are not the registered panel
// arms, so every slot is correctly reported NOT ESTIMABLE (issue #145). Stage
// 1b's own family is two contrasts against a solo reference:
//
//   S1b-1 = S1B-PANEL  - S1B-SOLO60   (does the panel beat one call?)
//   S1b-2 = S1B-PANEL  - S1B-APRIME   (is it the personas, or just 5 samples?)
//
// The first Stage 1b run's headline numbers were computed by an ad-hoc script
// that was not committed, so they could not be reproduced from the repo. That
// is the gap this file closes: the registered estimand now has a registered
// command, on the same footing as `variance-components.mjs --n60-scale`.
//
// The estimand is the RAREFIED distinct_k (Appendix C items 2-5): every pool in
// a contrast is rarefied to the minimum pool size present, which is a RESULT of
// the run and not a design parameter -- Appendix J item 8 registers how to read
// it (reported with the cell that set it; >= 48 leaves the contrast primary).
// Full-pool distinct_k is reported alongside as the secondary descriptive.
//
// Usage:
//   node evals/analysis/stage1b.mjs --results-dir results-study1b-r2

import { ResultsStore } from "../../lib/store.mjs";
import { buildFrame, summarizeByArm } from "./frame.mjs";
import { resolveStoreConfigHash } from "./storeConfig.mjs";
import { buildRarefiedFrame } from "./rarefiedFrame.mjs";
import { evaluateContrast, armCoefficientName, contrastVector } from "./contrasts.mjs";
import { runLadder, makeSidecarRunner } from "./fit.mjs";
import { holmBonferroni } from "./multiplicity.mjs";
import { paretoFrontier, costDiversityRatioByArm, seedFromString } from "./pareto.mjs";
import { VOYAGE_CLUSTER_DISTANCE_THRESHOLD } from "../metrics/voyage-calibration.mjs";

/** The registered arms. Constants here, not reads of arms.config.json, for the
 *  reason Appendix G item 5 gives: a registered number must not move when a
 *  config does. */
export const S1B_REFERENCE_ARM = "S1B-SOLO60";
export const S1B_PANEL_ARM = "S1B-PANEL";
export const S1B_APRIME_ARM = "S1B-APRIME";

/** Appendix J item 8: at or above this rarefaction floor the contrast is
 *  primary as registered; below it the contrast is still REPORTED, flagged as
 *  not comparable to the registered target, and the cell that set the floor is
 *  named. It is never re-planned to raise the floor -- that would be selecting
 *  on the outcome. */
export const REGISTERED_FLOOR_MIN = 48;

/** The registered family: two contrasts, so Holm runs at m=2. */
export const S1B_FAMILY = [
  { id: "S1b-1", description: `${S1B_PANEL_ARM} - ${S1B_REFERENCE_ARM} (does the panel beat one call?)`, arm: S1B_PANEL_ARM },
  { id: "S1b-2", description: `${S1B_PANEL_ARM} - ${S1B_APRIME_ARM} (personas, or just five samples?)`, arm: S1B_PANEL_ARM, minus: S1B_APRIME_ARM },
];

export function buildS1bSpecs(coefficientNames, referenceArm) {
  return S1B_FAMILY.map((f) => {
    const weights = {};
    weights[armCoefficientName(f.arm, referenceArm)] = 1;
    if (f.minus) weights[armCoefficientName(f.minus, referenceArm)] = -1;
    return { ...f, weights, vector: contrastVector(coefficientNames, weights) };
  });
}

// ── The registered headline metric: distinct_k per dollar (#182) ───────────
//
// §4.1 registers distinct_k/cost as "The headline metric. Answers the question
// actually asked." (docs/PREREGISTRATION.md:165), and Appendix C item 3
// registers its BASIS as "full-pool, self-correcting" (:823) -- never the
// rarefied frame the contrasts are fit on. §6.3 registers the companion
// output: "not report a single best model -- the output is a cost/diversity
// Pareto frontier". B6 registers the CI method (cluster bootstrap over
// briefs) and that the lane is always labelled descriptive.
//
// Deliberately mirrors stage1c.mjs's computeS1cCostLane near-verbatim -- the
// same convention these two files already follow for buildS1bSpecs, the family
// constants and the whole print flow. Stage 1b has its own arm set and its own
// selection (a single configHash, resolved by resolveStoreConfigHash, with no
// per-arm hash rule); a shared helper would have to be parameterised on both
// stages' selection rules for no reader benefit.

/**
 * The §6.3 Pareto frontier and the §4.1 distinct_k-per-dollar ratio (with B6's
 * cluster-bootstrap CI) per arm, over Stage 1b's FULL-POOL frame.
 *
 * Exported so the tests exercise it on synthetic frames with no results store
 * (the real stores are gitignored and absent from a build worktree).
 *
 * @param {ReturnType<typeof buildFrame>} frame
 *   Stage 1b's full-pool, post-selection frame. A rarefied frame is refused,
 *   not silently accepted -- see the Appendix C item 3 guard below.
 * @param {object} [opts]
 *   @param {number} [opts.seed]  bootstrap PRNG seed; defaults to one derived
 *     from the frame's configHash set, never wall-clock (#46 QA SHOULD).
 *   Remaining keys are forwarded to costDiversityRatio (iterations,
 *   confidenceLevel).
 * @returns {{
 *   basis: "full-pool", seed: number,
 *   paretoPoints: ReturnType<typeof paretoFrontier>,
 *   costRatioByArm: ReturnType<typeof costDiversityRatioByArm>,
 * }}
 */
export function computeS1bCostLane(frame, opts = {}) {
  // Appendix C item 3: the ratio is registered on the full-pool,
  // self-correcting basis. Handing this the rarefied frame would silently
  // report a DIFFERENT estimand under the headline metric's name, and nothing
  // downstream could tell -- both frames are structurally identical. Refuse
  // instead. `rarefied`/`responseFullPool` are buildRarefiedFrame's own
  // markers (rarefiedFrame.mjs), so this recognises the real thing rather
  // than a naming convention.
  if (frame.rarefied || (Array.isArray(frame.rows) && frame.rows.some((r) => r.responseFullPool !== undefined))) {
    throw new Error(
      "computeS1bCostLane: refusing a RAREFIED frame. distinct_k per dollar is registered on the " +
        '"full-pool, self-correcting" basis (docs/PREREGISTRATION.md Appendix C item 3, §4.1) -- pass the ' +
        "full-pool frame, not buildRarefiedFrame()'s output.",
    );
  }
  if (!Array.isArray(frame.rows) || frame.rows.length === 0) {
    throw new Error("computeS1bCostLane: frame.rows is empty -- there is no cost lane to compute");
  }
  const seed = opts.seed ?? seedFromString((frame.configHashes ?? [frame.configHash ?? ""]).join(","));
  const summaries = summarizeByArm(frame);
  const paretoPoints = paretoFrontier(
    summaries.map((a) => ({ armId: a.armId, meanCostUsd: a.meanCostUsd, meanResponse: a.meanResponse })),
  );
  const costRatioByArm = costDiversityRatioByArm(frame, { ...opts, seed });
  return { basis: "full-pool", seed, paretoPoints, costRatioByArm };
}

/**
 * The two lane sections as lines of text. PURE and exported for the reason
 * report.mjs's renderers are: a printer that only ever reaches a terminal is a
 * printer no test can check, and the CLI is the one surface this issue
 * delivers (a formatting slip here is invisible until someone runs it against
 * the real store, which is gitignored).
 *
 * @param {ReturnType<typeof computeS1bCostLane>} lane
 * @returns {string[]}
 */
export function formatCostLane(lane) {
  const lines = [];
  lines.push("");
  lines.push("=== cost/diversity Pareto frontier (§6.3, full-pool basis) ===");
  for (const p of lane.paretoPoints) {
    lines.push(
      `  ${p.armId.padEnd(14)} mean cost=$${p.meanCostUsd.toFixed(4)}  mean distinct_k=${p.meanResponse.toFixed(3)}` +
        `  on frontier: ${p.onFrontier ? "yes" : "no"}`,
    );
  }
  lines.push("");
  lines.push("=== distinct_k per dollar (the §4.1 headline metric; DESCRIPTIVE per amendment B6) ===");
  lines.push(`  basis: ${lane.basis} (Appendix C item 3), cluster-bootstrap CI over briefs, seed ${lane.seed}`);
  for (const [armId, r] of Object.entries(lane.costRatioByArm)) {
    lines.push(
      `  ${armId.padEnd(14)} ratio=${r.ratio.toFixed(3)}  ` +
        `${(r.confidenceLevel * 100).toFixed(0)}% CI [${r.ciLower.toFixed(3)}, ${r.ciUpper.toFixed(3)}]` +
        `  (${r.iterations} bootstrap iterations over briefs)`,
    );
  }
  return lines;
}

async function main(argv) {
  let resultsDir = "results-study1b-r2";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--results-dir") resultsDir = argv[++i];
  }

  const store = new ResultsStore(resultsDir);
  // resolveStoreConfigHash returns { configHash, tally } and refuses to choose
  // when a store holds several incomparable experiments -- exactly the state
  // that used to surface downstream as an empty `armLevels`.
  const { configHash: cfg } = resolveStoreConfigHash(store, {});
  // `poolField` is what makes the rarefied lane possible at all: without it a
  // frame carries only the scalar distinct_k, and Appendix C's estimand cannot
  // be computed. "pool" matches analysis.mjs's own default.
  const frame = buildFrame(store, { configHash: cfg, responseField: "distinct_k", poolField: "pool" });

  console.log(`store: ${resultsDir}   configHash: ${cfg}`);
  console.log(`arms in frame: ${frame.armLevels.join(", ")}`);
  console.log(`rows: ${frame.rows.length}`);

  console.log("\n=== full-pool distinct_k by arm (secondary descriptive, Appendix C item 5) ===");
  for (const s of summarizeByArm(frame)) {
    console.log(`  ${s.armId.padEnd(14)} n=${String(s.n).padEnd(4)} mean=${s.meanResponse.toFixed(3)}  mean cost=$${s.meanCostUsd.toFixed(4)}`);
  }

  // #182: the registered headline metric, on the FULL-POOL frame -- before
  // rarefaction, which the contrasts below use instead.
  for (const line of formatCostLane(computeS1bCostLane(frame))) console.log(line);

  const armIds = [S1B_REFERENCE_ARM, S1B_PANEL_ARM, S1B_APRIME_ARM];
  const rarefied = buildRarefiedFrame(frame, {
    armIds,
    threshold: VOYAGE_CLUSTER_DISTANCE_THRESHOLD,
    metric: "distinct_k",
  });

  const floors = rarefied.rows.map((r) => r.rarefiedN).filter((n) => Number.isFinite(n));
  const floor = Math.min(...floors);
  const setter = rarefied.rows.find((r) => r.poolSize === floor);
  console.log(`\n=== rarefaction floor (Appendix J item 8) ===`);
  console.log(`  achieved floor: ${floor}`);
  console.log(`  set by cell:    ${setter ? setter.cellKey : "(not identified)"}`);
  console.log(
    floor >= REGISTERED_FLOOR_MIN
      ? `  >= ${REGISTERED_FLOOR_MIN}: contrasts are PRIMARY as registered.`
      : `  < ${REGISTERED_FLOOR_MIN}: contrasts are REPORTED but NOT COMPARABLE to the registered target.`,
  );

  console.log("\n=== rarefied distinct_k by arm (the registered estimand) ===");
  for (const s of summarizeByArm(rarefied)) {
    console.log(`  ${s.armId.padEnd(14)} n=${String(s.n).padEnd(4)} mean=${s.meanResponse.toFixed(3)}`);
  }

  const runner = makeSidecarRunner();
  const { fit, rung } = await runLadder({
    rows: rarefied.rows,
    armLevels: rarefied.armLevels,
    referenceArm: S1B_REFERENCE_ARM,
    runner,
  });
  console.log(`\nfitted at rung ${rung}`);

  const specs = buildS1bSpecs(fit.coefficientNames, S1B_REFERENCE_ARM);
  const results = specs.map((s) => ({ ...s, ...evaluateContrast(fit, s.vector) }));
  const adjusted = holmBonferroni(results.map((r) => r.p));

  console.log("\n=== Stage 1b registered family (Holm, m=2) ===");
  console.log("| ID | Contrast | Estimate | SE | 95% CI | Holm p |");
  console.log("|---|---|---|---|---|---|");
  results.forEach((r, i) => {
    console.log(
      `| ${r.id} | ${r.description} | ${r.estimate.toFixed(4)} | ${r.se.toFixed(4)} | [${r.ci[0].toFixed(3)}, ${r.ci[1].toFixed(3)}] | ${adjusted[i].toFixed(4)} |`,
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
