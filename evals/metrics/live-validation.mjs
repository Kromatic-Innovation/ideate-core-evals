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
import { datReplication, negativeControls } from "./validation.mjs";
import { RANDOM_TEXT_POOL, DUPLICATE_POOL } from "./fixtures/control-texts.mjs";

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(4) : String(n);
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
  const controls = await negativeControls(embedder);

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
  // borrowing the hermetic fixture's recorded number.
  const randomPass = controls.random.distinctK >= Math.ceil(RANDOM_TEXT_POOL.length * 0.9) && controls.random.diversity >= dat.high;
  if (randomPass) {
    console.log("  PASS: random pool stays overwhelmingly distinct and clears the live DAT-high diversity floor");
  } else {
    console.error(
      "  FAIL: random pool did not stay distinct / diverse enough (want distinct_k >= 90% of pool and " +
        `diversity >= live DAT-high floor of ${fmt(dat.high)}). Reported honestly, not worked around.`,
    );
    ok = false;
  }

  console.log(`\n[live-validation] usage: ${embedder.usage.total_tokens} total_tokens`);
  console.log(`[live-validation] ${ok ? "ALL CHECKS PASSED" : "ONE OR MORE CHECKS FAILED"}`);

  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[live-validation] failed:", err.stack || err.message);
  process.exitCode = 1;
});
