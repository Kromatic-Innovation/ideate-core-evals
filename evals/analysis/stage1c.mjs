#!/usr/bin/env node
// Stage 1c's registered two-contrast family (docs/PREREGISTRATION.md Appendix L).
//
//   S1c-1 = S1C-RICH - S1C-SOLO60     (does a RICHLY differentiated panel beat one call?)
//   S1c-2 = S1C-RICH - S1C-SOLO6X10   (is it the personas, or just ten small calls?)
//
// S1c-2 is the control Stage 1b lacked: S1C-SOLO6X10 holds agent count and
// ideas-per-call at the panel's values while removing rounds AND sharing, so it
// separates "the panel works" from "ten small calls were always fine".
//
// WHY THIS FILE EXISTS: analysis.mjs fits the §6.1 registered family H1-H5, and
// Stage 1b cannot estimate any of them -- its arms are not the registered panel
// arms, so every slot is correctly reported NOT ESTIMABLE (issue #145). Stage
// 1b's own family is two contrasts against a solo reference:
//
// Appendix L item 4 registers the SOLO60 BRIDGE: the thin S1B-PANEL is not
// re-run, so a RICH-vs-PANEL comparison would cross a configHash boundary. If
// this run's S1C-SOLO60 rarefied mean reproduces Stage 1b's 44.570 within its
// CI, that comparison is reportable as clearly-labelled SECONDARY; if it does
// not reproduce, the claim is not made at all.
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
//   node evals/analysis/stage1c.mjs --results-dir results-study1c

import { ResultsStore } from "../../lib/store.mjs";
import { buildFrame, summarizeByArm } from "./frame.mjs";
import { resolveStoreConfigHash } from "./storeConfig.mjs";
import { buildRarefiedFrame } from "./rarefiedFrame.mjs";
import { evaluateContrast, armCoefficientName, contrastVector } from "./contrasts.mjs";
import { runLadder, makeSidecarRunner } from "./fit.mjs";
import { holmBonferroni } from "./multiplicity.mjs";
import { VOYAGE_CLUSTER_DISTANCE_THRESHOLD } from "../metrics/voyage-calibration.mjs";

/** The registered arms. Constants here, not reads of arms.config.json, for the
 *  reason Appendix G item 5 gives: a registered number must not move when a
 *  config does. */
export const S1C_REFERENCE_ARM = "S1C-SOLO60";
export const S1C_PANEL_ARM = "S1C-RICH";
/** Not an "A-prime" any more — Stage 1c's third arm is the missing CONTROL, not
 *  a persona ablation. Named for what it is. */
export const S1C_CONTROL_ARM = "S1C-SOLO6X10";

/** Appendix J item 8: at or above this rarefaction floor the contrast is
 *  primary as registered; below it the contrast is still REPORTED, flagged as
 *  not comparable to the registered target, and the cell that set the floor is
 *  named. It is never re-planned to raise the floor -- that would be selecting
 *  on the outcome. */
export const REGISTERED_FLOOR_MIN = 48;

/** The registered family: two contrasts, so Holm runs at m=2. */
export const S1C_FAMILY = [
  { id: "S1c-1", description: `${S1C_PANEL_ARM} - ${S1C_REFERENCE_ARM} (does a RICHLY differentiated panel beat one call?)`, arm: S1C_PANEL_ARM },
  { id: "S1c-2", description: `${S1C_PANEL_ARM} - ${S1C_CONTROL_ARM} (personas, or just ten small calls?)`, arm: S1C_PANEL_ARM, minus: S1C_CONTROL_ARM },
];

export function buildS1bSpecs(coefficientNames, referenceArm) {
  return S1C_FAMILY.map((f) => {
    const weights = {};
    weights[armCoefficientName(f.arm, referenceArm)] = 1;
    if (f.minus) weights[armCoefficientName(f.minus, referenceArm)] = -1;
    return { ...f, weights, vector: contrastVector(coefficientNames, weights) };
  });
}

async function main(argv) {
  let resultsDir = "results-study1c";
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

  const armIds = [S1C_REFERENCE_ARM, S1C_PANEL_ARM, S1C_CONTROL_ARM];
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
    referenceArm: S1C_REFERENCE_ARM,
    runner,
  });
  console.log(`\nfitted at rung ${rung}`);

  const specs = buildS1bSpecs(fit.coefficientNames, S1C_REFERENCE_ARM);
  const results = specs.map((s) => ({ ...s, ...evaluateContrast(fit, s.vector) }));
  const adjusted = holmBonferroni(results.map((r) => r.p));

  // Appendix L item 4: the bridge check, computed rather than asserted.
  const solo = summarizeByArm(rarefied).find((s) => s.armId === S1C_REFERENCE_ARM);
  if (solo) {
    const STAGE_1B_SOLO60_RAREFIED = 44.57;
    console.log(`\n=== SOLO60 bridge check (Appendix L item 4) ===`);
    console.log(`  Stage 1b S1B-SOLO60 rarefied mean: ${STAGE_1B_SOLO60_RAREFIED}`);
    console.log(`  this run's S1C-SOLO60:             ${solo.meanResponse.toFixed(3)}`);
    console.log(`  difference:                        ${(solo.meanResponse - STAGE_1B_SOLO60_RAREFIED).toFixed(3)}`);
    console.log(`  A cross-run RICH-vs-S1B-PANEL comparison is reportable as SECONDARY only if`);
    console.log(`  these agree AND the rarefaction floors match (Stage 1b's was 50).`);
  }

  console.log("\n=== Stage 1c registered family (Holm, m=2) ===");
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
