#!/usr/bin/env node
// live-validation.mjs — run the DAT replication + negative controls against
// the LIVE Voyage-4-lite embedder.
//
// ── OPT-IN, LIVE, NEVER RUN BY `npm test` ───────────────────────────────────
// This script makes real, billed network calls to api.voyageai.com. It is
// NOT imported by any test file (verify: `grep -rn "live-validation" evals
// --include=*.test.mjs` returns nothing) and `node --test` never executes it
// — mirroring ./regen-fixtures.mjs's own "never in CI" contract (see that
// file's header). Run it manually, on demand, with a real VOYAGE_API_KEY:
//
//   VOYAGE_API_KEY=... node evals/metrics/live-validation.mjs
//
// ── Why this exists ──────────────────────────────────────────────────────
// dat-replication.test.mjs / negative-controls.test.mjs validate the HERMETIC
// fixture embedder (MiniLM) + the metric machinery. They say nothing about
// whether the PRODUCTION embedder (Voyage-4-lite) recovers the same DAT
// ordering or passes the same negative controls — issue #20 (AC3/AC4) closes
// that gap by running the exact same checks (./validation.mjs
// datReplication/negativeControls — the identical functions the hermetic
// tests exercise, just pointed at a live embedder instead of the fixture
// lookup) against the real API.
//
// ── Honesty requirement: report pass/fail, never work around a failure ─────
// If the live embedder fails to reproduce the DAT ordering, or a negative
// control doesn't separate the way it should, THAT IS THE CONTROL DOING ITS
// JOB — per the issue: "or fails, which is the control doing its job and
// must be reported, not worked around." This script never retries with a
// different threshold, never rounds a borderline number into a pass, and
// always sets a non-zero exit code on any failed check so it composes
// cleanly with CI-adjacent tooling even though it isn't run BY CI itself.

import { voyageEmbedder } from "./embedder.mjs";
import { datReplication, negativeControls, randomPoolVerdict } from "./validation.mjs";
import { RANDOM_TEXT_POOL, DUPLICATE_POOL } from "./fixtures/control-texts.mjs";
// The Voyage-calibrated threshold (issue #42), NOT calibration.mjs's MiniLM
// one — negativeControls' threshold is a parameter precisely so this live
// run can use the number calibrated for the embedder it actually runs
// against. See voyage-calibration.mjs header.
import { VOYAGE_CLUSTER_DISTANCE_THRESHOLD } from "./voyage-calibration.mjs";

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(4) : String(n);
}

/**
 * Pure random-pool reporter — the single source of truth for both what the
 * random-pool control PRINTS and whether it FAILS the run. It calls
 * validation.mjs's `randomPoolVerdict` and turns that verdict into console
 * lines plus a run-fail flag, so the caller no longer re-derives `ok` at two
 * separate sites (once for the distinct_k half, once for the diversity-floor
 * half). Extracting it makes the shipped gating rule reachable from a hermetic
 * test WITHOUT a live embedder: previously `live-validation.mjs` was
 * unimportable (its module-scope `main()` fired a billed run on import), so its
 * gating had zero coverage and the tested `verdict.failed` was dead — the two
 * could drift silently. Now `failed` here IS `verdict.failed`, which
 * validation.test.mjs asserts, so the tested rule is the shipped rule.
 *
 * @param {{ distinctK: number, diversity: number, poolSize: number, datHigh: number, orderingHolds: boolean }} args
 * @returns {{ lines: Array<{ level: "log" | "error", text: string }>, verdict: ReturnType<typeof randomPoolVerdict>, failed: boolean }}
 */
export function renderRandomPoolReport({ distinctK, diversity, poolSize, datHigh, orderingHolds }) {
  const verdict = randomPoolVerdict({ distinctK, diversity, poolSize, datHigh, orderingHolds });
  const lines = [];

  if (verdict.distinctKPass) {
    lines.push({
      level: "log",
      text: `  PASS: random pool stays overwhelmingly distinct (distinct_k >= ${Math.ceil(poolSize * 0.9)} of ${poolSize})`,
    });
  } else {
    lines.push({
      level: "error",
      text:
        `  FAIL: random pool did not stay distinct enough (want distinct_k >= 90% of pool, got ${distinctK}). ` +
        "Reported honestly, not worked around.",
    });
  }

  if (verdict.floorVerdict === "inconclusive") {
    lines.push({
      level: "log",
      text:
        `  INCONCLUSIVE: diversity=${fmt(diversity)} is printed but not judged against the live DAT-high ` +
        `floor of ${fmt(datHigh)} -- the floor is uncalibrated because the DAT ordering did not hold on this embedder ` +
        "(see the DAT replication FAIL above).",
    });
  } else if (verdict.floorVerdict === "pass") {
    lines.push({ level: "log", text: `  PASS: random pool diversity clears the live DAT-high diversity floor of ${fmt(datHigh)}` });
  } else {
    lines.push({
      level: "error",
      text:
        `  FAIL: random pool diversity (${fmt(diversity)}) did not clear the live DAT-high floor of ` +
        `${fmt(datHigh)}. Reported honestly, not worked around.`,
    });
  }

  // The run-fail decision IS verdict.failed — the caller consumes this rather
  // than re-deriving the rule inline, so the rule validation.test.mjs asserts
  // is exactly the rule the live script gates on.
  return { lines, verdict, failed: verdict.failed };
}

async function main() {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    console.error(
      "[live-validation] VOYAGE_API_KEY required. This script makes real, billed calls to the live " +
        "Voyage API and never invents or defaults a key. Set VOYAGE_API_KEY in the environment and re-run:\n" +
        "  VOYAGE_API_KEY=... node evals/metrics/live-validation.mjs",
    );
    process.exitCode = 1;
    return;
  }

  const embedder = voyageEmbedder({ apiKey });
  console.log(`[live-validation] embedder: ${embedder.modelId} (live Voyage API)`);

  let ok = true;

  // ── DAT replication ───────────────────────────────────────────────────────
  console.log("\n[live-validation] running DAT replication (§4.4) ...");
  const dat = await datReplication(embedder);
  console.log(`  low diversity      = ${fmt(dat.low)}`);
  console.log(`  average diversity  = ${fmt(dat.average)}`);
  console.log(`  high diversity     = ${fmt(dat.high)}`);
  console.log(`  margin (high-low)  = ${fmt(dat.margin)}`);
  if (dat.orderingHolds) {
    console.log("  PASS: ordering low < average < high holds on the live embedder");
  } else {
    console.error(
      "  FAIL: DAT replication did NOT reproduce the published ordering (low < average < high) on the " +
        "live Voyage-4-lite embedder. This is the control doing its job -- reported honestly, not " +
        "worked around. Downstream diversity/distinct_k numbers from this embedder should not be " +
        "trusted until this is understood.",
    );
    ok = false;
  }

  // ── Negative controls ────────────────────────────────────────────────────
  console.log("\n[live-validation] running negative controls (§4.4) ...");
  console.log(`  using Voyage-calibrated threshold ${VOYAGE_CLUSTER_DISTANCE_THRESHOLD} (see voyage-calibration.mjs, issue #42)`);
  const controls = await negativeControls(embedder, { threshold: VOYAGE_CLUSTER_DISTANCE_THRESHOLD });

  console.log(
    `  duplicate pool (${DUPLICATE_POOL.length} copies): distinct_k=${controls.duplicate.distinctK}, ` +
      `diversity=${fmt(controls.duplicate.diversity)}, collapseRate=${fmt(controls.duplicate.collapseRate)}`,
  );
  const duplicatePass = controls.duplicate.distinctK === 1 && controls.duplicate.diversity < 0.05;
  if (duplicatePass) {
    console.log("  PASS: duplicate pool collapses to distinct_k=1 / near-zero diversity");
  } else {
    console.error(
      "  FAIL: duplicate pool did not collapse as expected (want distinct_k=1, diversity~0). Reported " +
        "honestly, not worked around.",
    );
    ok = false;
  }

  console.log(
    `  random pool (${RANDOM_TEXT_POOL.length} sentences): distinct_k=${controls.random.distinctK}, ` +
      `diversity=${fmt(controls.random.diversity)}, collapseRate=${fmt(controls.random.collapseRate)}`,
  );
  // "near-max" is deliberately NOT asserted as a fixed absolute threshold
  // here (see fixtures/control-texts.mjs RANDOM_TEXT_POOL header on why
  // sentence embedders compress on topic/register) -- the check is that the
  // pool stays overwhelmingly distinct (>=90% of 30, mirroring
  // negative-controls.test.mjs's own bound) and diversity clears the DAT-
  // replication-derived high-group floor computed ABOVE on this same live
  // embedder, i.e. the live run calibrates its own floor rather than
  // borrowing the hermetic fixture's recorded number. These are TWO
  // independent claims reported separately (validation.mjs randomPoolVerdict):
  // the distinct_k half needs nothing from the DAT run and is always
  // judged; the diversity-floor half is only meaningful when
  // `dat.orderingHolds` is true, because `dat.high` is a self-calibrated
  // floor that is only calibrated when the DAT ordering (low < average <
  // high) actually held on this embedder. When ordering breaks, `dat.high`
  // can sit below `dat.average` or even `dat.low`, so asserting PASS/FAIL
  // against it would mislead in either direction -- report INCONCLUSIVE
  // instead and let the DAT-ordering failure above be the thing that fails
  // the run.
  // The random-pool control's printing AND its run-fail decision both come
  // from the one pure reporter (renderRandomPoolReport -> randomPoolVerdict),
  // so the run-failing rule is exactly the one validation.test.mjs asserts and
  // the caller no longer re-derives `ok` at two separate sites.
  const report = renderRandomPoolReport({
    distinctK: controls.random.distinctK,
    diversity: controls.random.diversity,
    poolSize: RANDOM_TEXT_POOL.length,
    datHigh: dat.high,
    orderingHolds: dat.orderingHolds,
  });
  for (const line of report.lines) {
    if (line.level === "error") console.error(line.text);
    else console.log(line.text);
  }
  if (report.failed) ok = false;

  console.log(`\n[live-validation] usage: ${embedder.usage.total_tokens} total_tokens`);
  console.log(`[live-validation] ${ok ? "ALL CHECKS PASSED" : "ONE OR MORE CHECKS FAILED"}`);

  if (!ok) process.exitCode = 1;
}

// Only auto-run when this file is the actual entry point
// (`node evals/metrics/live-validation.mjs`), never when it is imported for its
// exports (e.g. renderRandomPoolReport from live-validation.test.mjs). Without
// this guard — matching evals/run.mjs's own guard — importing this module in a
// test would immediately fire main(), which makes real, billed Voyage API calls
// and would violate the repo's no-network-in-tests invariant.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[live-validation] failed:", err.stack || err.message);
    process.exitCode = 1;
  });
}
