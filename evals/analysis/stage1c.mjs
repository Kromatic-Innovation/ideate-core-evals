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

// ── Appendix M item 5: each arm comes from exactly ONE configHash ───────────
//
// #168 keyed the per-request output floor by effort, which moved promptHash and
// therefore configHash. The two SOLO control arms run entirely at `high`, which
// #168 does not touch, so their requests are byte-identical across the move
// (26250 and 6873 on both sides -- asserted in prompts.test.mjs against
// hard-coded pre-#168 literals). They are REUSED rather than re-collected.
//
// S1C-RICH is re-collected, and the old-hash S1C-RICH cells must NOT come with
// it. Only 5 of 144 survived the truncation defect, and they are exactly the
// cells in which none of the four max-effort replies truncated -- the most
// outcome-selected subset in the store. Pooling the two hashes wholesale would
// fold that censored subsample into the corrected treatment arm and bias the
// contrast the study exists to estimate.
//
// So the rule is per ARM, not per store, and it is applied BEFORE rarefaction:
// buildRarefiedFrame rarefies to the minimum pool size present, so a
// contaminated row left in the frame would move the floor for every arm.

/** The configHash Stage 1c's first run wrote, under which both control arms
 *  (and the 5 discarded S1C-RICH survivors) are stored. A literal, because it
 *  is a fact about an existing store rather than something to re-derive. */
export const PRE_168_CONFIG_HASH = "fb16a8434518";

/**
 * Resolve which configHash each registered arm is taken from.
 *
 * The pre-#168 hash is pinned; the post-#168 hash is whatever the corrected
 * run wrote, validated to be exactly one OTHER hash rather than guessed. The
 * assertion that matters is that the treatment arm's hash is NOT the pre-#168
 * one -- that is what guarantees the 5 contaminated cells are excluded.
 *
 * A store still holding only the pre-#168 hash (the re-collect has not run)
 * returns null, and the caller reports that rather than analysing controls
 * against a treatment arm that is 96% missing.
 *
 * @param {ReturnType<typeof import("./storeConfig.mjs").tallyStoredConfigs>} tally
 * @returns {{armHashes: Record<string,string>, post: string}|null}
 */
export function resolveS1cArmHashes(tally) {
  const hashes = tally.map((t) => t.cfg);
  if (!hashes.includes(PRE_168_CONFIG_HASH)) {
    throw new Error(
      `stage1c: store does not hold the pre-#168 configHash ${PRE_168_CONFIG_HASH}, which both control arms are stored under. ` +
        `Holds: ${hashes.join(", ") || "nothing"}. This analysis is specific to the Stage 1c store (Appendix M item 5).`,
    );
  }
  const others = hashes.filter((h) => h !== PRE_168_CONFIG_HASH);
  if (others.length === 0) return null;
  if (others.length > 1) {
    throw new Error(
      `stage1c: store holds ${others.length} post-#168 configHashes (${others.join(", ")}); ` +
        `Appendix M item 5 assigns S1C-RICH to exactly one and this tool will not choose between them.`,
    );
  }
  const post = others[0];
  return {
    post,
    armHashes: {
      [S1C_REFERENCE_ARM]: PRE_168_CONFIG_HASH,
      [S1C_CONTROL_ARM]: PRE_168_CONFIG_HASH,
      [S1C_PANEL_ARM]: post,
    },
  };
}

/**
 * Drop every row whose arm did not come from that arm's assigned configHash.
 *
 * Returns a NEW frame; the input is not mutated. `armLevels` is rebuilt from
 * the surviving rows, so an arm left with nothing disappears rather than
 * lingering as an empty level that downstream fitting would trip over.
 *
 * @param {ReturnType<typeof buildFrame>} frame
 * @param {Record<string,string>} armHashes
 */
export function applyArmHashRule(frame, armHashes) {
  const kept = [];
  const dropped = [];
  for (const row of frame.rows) {
    const want = armHashes[row.armId];
    if (want === undefined || row.cfg === want) kept.push(row);
    else dropped.push(row);
  }
  const armLevels = frame.armLevels.filter((a) => kept.some((r) => r.armId === a));
  return { ...frame, rows: kept, armLevels, droppedByArmHashRule: dropped };
}

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
  // Appendix M item 5: the two hashes are named here rather than resolved by
  // resolveStoreConfigHash's single-hash path, because this store deliberately
  // holds two and each ARM is assigned to one of them.
  const { tally } = (() => {
    try {
      return resolveStoreConfigHash(store, { configHash: PRE_168_CONFIG_HASH, resultsDir });
    } catch (e) {
      if (e.name === "UnknownStoredConfigError") return { tally: e.tally };
      throw e;
    }
  })();

  const assignment = resolveS1cArmHashes(tally);
  if (assignment === null) {
    console.error(
      `stage1c: the store holds ONLY the pre-#168 configHash ${PRE_168_CONFIG_HASH}. The corrected S1C-RICH\n` +
        `re-collect has not run, so the treatment arm is 139/144 missing and no contrast is computable.\n` +
        `Run:  ./scripts/run-study1c.sh S1C-RICH`,
    );
    process.exit(1);
  }
  const { armHashes, post } = assignment;

  // `poolField` is what makes the rarefied lane possible at all: without it a
  // frame carries only the scalar distinct_k, and Appendix C's estimand cannot
  // be computed. "pool" matches analysis.mjs's own default.
  const pooled = buildFrame(store, {
    configHash: [PRE_168_CONFIG_HASH, post],
    responseField: "distinct_k",
    poolField: "pool",
  });
  // BEFORE rarefaction, on purpose -- see the Appendix M item 5 block above.
  const frame = applyArmHashRule(pooled, armHashes);

  console.log(`store: ${resultsDir}`);
  console.log(`configHash (controls, pre-#168): ${PRE_168_CONFIG_HASH}`);
  console.log(`configHash (S1C-RICH, post-#168): ${post}`);
  console.log(`arms in frame: ${frame.armLevels.join(", ")}`);
  console.log(`rows: ${frame.rows.length}`);
  const droppedRich = frame.droppedByArmHashRule.filter((r) => r.armId === S1C_PANEL_ARM).length;
  console.log(
    `dropped by the per-arm hash rule: ${frame.droppedByArmHashRule.length}` +
      ` (of which ${droppedRich} are the outcome-selected old-hash ${S1C_PANEL_ARM} survivors -- Appendix M item 5)`,
  );

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
