#!/usr/bin/env node
// calibrate-voyage.mjs — OPT-IN, LIVE script that:
//   1. demonstrates whether the existing MiniLM-derived CLUSTER_DISTANCE_
//      THRESHOLD (calibration.mjs) transfers to Voyage-4-lite space, by
//      embedding the same 8 fixture pairs (control-texts.mjs
//      PARAPHRASE_PAIRS/DISTINCT_IDEA_PAIRS) live and reporting the actual
//      distances against it; and
//   2. selects a Voyage-space threshold from the real ≥100-pair calibration
//      set (fixtures/calibration-pairs.mjs) via the registered rule
//      (threshold-selection.mjs selectThreshold), and writes the result as a
//      durable, machine-readable JSON record.
//
// Mirrors phase0.mjs's own contract: never imported by a test file with a
// real key, never runs under `node --test`, makes real billed calls to
// api.voyageai.com, requires VOYAGE_API_KEY (never invented/defaulted), and
// reports findings honestly — a threshold that fails to transfer, or a
// calibration set with a low achievable balanced accuracy, is reported as
// such, not worked around.
//
//   VOYAGE_API_KEY=... node evals/metrics/calibrate-voyage.mjs [--write]
//
// Without --write, the script only prints its findings (dry run). With
// --write, it also writes fixtures/voyage-calibration-result.json — the
// durable record #44's Appendix B can register (issue #42, item 6).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { voyageEmbedder } from "./embedder.mjs";
import { cosineDistance } from "./clustering.mjs";
import { CLUSTER_DISTANCE_THRESHOLD as MINILM_THRESHOLD } from "./calibration.mjs";
import { selectThreshold, pairSetHash } from "./threshold-selection.mjs";
import { PARAPHRASE_PAIRS, DISTINCT_IDEA_PAIRS } from "./fixtures/control-texts.mjs";
import { CALIBRATION_PAIRS, CALIBRATION_SET_PROVENANCE } from "./fixtures/calibration-pairs.mjs";

const RESULT_PATH = fileURLToPath(new URL("./fixtures/voyage-calibration-result.json", import.meta.url));

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(4) : String(n);
}

async function embedPairs(embedder, pairs) {
  const texts = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const vecs = await embedder.embed(texts);
  const byText = new Map(texts.map((t, i) => [t, vecs[i]]));
  return pairs.map((p) => cosineDistance(byText.get(p.a), byText.get(p.b)));
}

async function main() {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    console.error(
      "[calibrate-voyage] VOYAGE_API_KEY required. This script makes real, billed calls to the live " +
        "Voyage API and never invents or defaults a key. Set VOYAGE_API_KEY in the environment and re-run:\n" +
        "  VOYAGE_API_KEY=... node evals/metrics/calibrate-voyage.mjs",
    );
    process.exitCode = 1;
    return;
  }

  const write = process.argv.includes("--write");
  const embedder = voyageEmbedder({ apiKey });

  // ── Step 1: does the MiniLM-derived threshold transfer? ──────────────────
  console.log(`[calibrate-voyage] embedder: ${embedder.modelId} (live Voyage API)`);
  console.log("\n[calibrate-voyage] Step 1 -- does the MiniLM-derived threshold transfer to Voyage space?");
  console.log(`  MiniLM CLUSTER_DISTANCE_THRESHOLD = ${fmt(MINILM_THRESHOLD)}`);

  const paraDistances = await embedPairs(embedder, PARAPHRASE_PAIRS.map(([a, b]) => ({ a, b })));
  const distDistances = await embedPairs(embedder, DISTINCT_IDEA_PAIRS.map(([a, b]) => ({ a, b })));
  const maxPara = Math.max(...paraDistances);
  const minDist = Math.min(...distDistances);

  console.log(`  Voyage paraphrase distances:     [${paraDistances.map(fmt).join(", ")}]  (max=${fmt(maxPara)})`);
  console.log(`  Voyage distinct-idea distances:  [${distDistances.map(fmt).join(", ")}]  (min=${fmt(minDist)})`);

  const overlap = maxPara >= minDist;
  const transfers = !overlap && MINILM_THRESHOLD > maxPara && MINILM_THRESHOLD < minDist;
  if (overlap) {
    console.error(
      "  FAIL TO TRANSFER: on Voyage embeddings, the paraphrase and distinct-idea populations OVERLAP " +
        "on this narrow 8-pair fixture -- no threshold could separate them cleanly, let alone the MiniLM one.",
    );
  } else if (transfers) {
    console.log(
      "  On this narrow 8-pair fixture, the MiniLM threshold happens to still sit strictly between the " +
        "Voyage populations. NOTE: this is a coincidence of two extreme, easily-separated populations " +
        "(paraphrase vs. cross-topic distinct pairs) and does NOT establish the threshold is correctly " +
        "calibrated for real pools -- see Step 2 for the test that matters: hard-negative, same-brief " +
        "pairs at realistic scale.",
    );
  } else {
    console.error(
      `  FAIL TO TRANSFER: the MiniLM threshold (${fmt(MINILM_THRESHOLD)}) does not sit between the Voyage ` +
        `populations (max paraphrase=${fmt(maxPara)}, min distinct=${fmt(minDist)}).`,
    );
  }

  // ── Step 2: select a Voyage-space threshold from the real calibration set ─
  console.log(
    `\n[calibrate-voyage] Step 2 -- selecting a threshold from ${CALIBRATION_PAIRS.length} labelled ` +
      "hard-negative pairs (fixtures/calibration-pairs.mjs)...",
  );
  console.log(`  labels: ${JSON.stringify(CALIBRATION_SET_PROVENANCE)}`);

  const calDistances = await embedPairs(embedder, CALIBRATION_PAIRS);
  const calLabels = CALIBRATION_PAIRS.map((p) => p.label);
  const selection = selectThreshold(calDistances, calLabels);
  const hash = pairSetHash(CALIBRATION_PAIRS);

  console.log(`  pair-set hash: ${hash}`);
  console.log(`  selected threshold: ${fmt(selection.threshold)}`);
  console.log(`  achieved balanced accuracy: ${fmt(selection.achievedBalancedAccuracy)}`);
  if (selection.achievedBalancedAccuracy < 0.9) {
    console.error(
      "  NOTE: achieved balanced accuracy is well below 1.0 -- reported honestly. The pairwise " +
        "same/different distance populations overlap on this realistic hard-negative set; distinct_k " +
        "under any single threshold is a blunter instrument on real pools than the clean 8-pair fixture " +
        "suggested.",
    );
  }

  // Also compare the MiniLM number's balanced accuracy on THIS realistic set,
  // for a direct apples-to-apples comparison to the selected number.
  const { balancedAccuracy: miniLmBAOnRealSet } = (await import("./threshold-selection.mjs")).balancedAccuracyAt(
    calDistances,
    calLabels,
    MINILM_THRESHOLD,
  );
  console.log(
    `  for comparison: the MiniLM threshold (${fmt(MINILM_THRESHOLD)}) achieves balanced accuracy ` +
      `${fmt(miniLmBAOnRealSet)} on this same realistic Voyage-embedded set.`,
  );

  console.log(`\n[calibrate-voyage] usage: ${embedder.usage.total_tokens} total_tokens`);

  const record = {
    embedderId: embedder.modelId,
    generatedAt: new Date().toISOString(),
    pairSetHash: hash,
    pairSetSize: CALIBRATION_PAIRS.length,
    pairSetProvenance: CALIBRATION_SET_PROVENANCE,
    selectionRule: selection.selectionRule,
    clusterDistanceThreshold: selection.threshold,
    achievedBalancedAccuracy: selection.achievedBalancedAccuracy,
    miniLmThresholdOnThisSet: {
      threshold: MINILM_THRESHOLD,
      balancedAccuracy: miniLmBAOnRealSet,
    },
    narrowFixtureTransferCheck: {
      miniLmThreshold: MINILM_THRESHOLD,
      voyageMaxParaphraseDistance: maxPara,
      voyageMinDistinctDistance: minDist,
      populationsOverlap: overlap,
      thresholdSitsBetweenPopulations: transfers,
    },
    deviationNotes: [
      "Threshold selected as pairwise-optimal balanced accuracy; consumed by clusterByThreshold under " +
        "average-linkage over ~30-item pools, which merges on a mean cross-cluster distance, not a single " +
        "pairwise distance. A defensible proxy, not an identical quantity.",
      "±0.05 sensitivity band (see sensitivity.mjs) is a MiniLM-era registered figure, not re-derived " +
        "from the Voyage same/different gap -- report it as a fraction of the observed gap alongside any " +
        "sensitivity result.",
    ],
  };

  console.log(`\n[calibrate-voyage] durable record:\n${JSON.stringify(record, null, 2)}`);

  if (write) {
    writeFileSync(RESULT_PATH, JSON.stringify(record, null, 2) + "\n");
    console.log(`\n[calibrate-voyage] wrote ${RESULT_PATH}`);
  } else {
    console.log("\n[calibrate-voyage] dry run (pass --write to persist fixtures/voyage-calibration-result.json)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[calibrate-voyage] failed:", err.stack || err.message);
    process.exitCode = 1;
  });
}
