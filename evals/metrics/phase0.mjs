// phase0.mjs — orchestrates docs/PREREGISTRATION.md §8.3 Phase 0 (issue #48):
// run the negative controls + DAT replication against the LIVE Voyage-4-lite
// embedder, using the REGISTERED Voyage-calibrated clustering threshold
// (issue #42, Appendix B item 8 — VOYAGE_CLUSTER_DISTANCE_THRESHOLD, NOT the
// MiniLM one), and persist the result to the additive results store
// (lib/store.mjs) as first-class rows — never console-only output.
//
// ── Scope: THREE controls, not four ─────────────────────────────────────────
// §4.4's table (as amended by Appendix B item 12) lists a fourth control,
// judge test-retest, replacing the vacuous shuffled-label control. This
// module deliberately does NOT run it: judge spend needs #63 (judge cost-
// accounting fix) and #64 (cumulative spend ceiling) landed first, so it is
// not yet fully observable by the ceilings. See evals/run.mjs's --phase 0
// wiring and the issue for the explicit deferral. Running three controls
// here, silently, and calling it "Phase 0 complete" would misrepresent
// what's covered — this module's return value and store rows only ever
// speak to the three controls it actually ran.
//
// ── Why this is a separate module from live-validation.mjs ─────────────────
// live-validation.mjs (issue #20) already runs these same three controls
// live and reports pass/fail to the console — but it never persists
// anything, and its `main()` is not deps-injectable (reads
// process.env.VOYAGE_API_KEY and constructs its own embedder directly), so
// it cannot be exercised hermetically end-to-end. This module reuses the
// exact same computation (./validation.mjs datReplication/negativeControls
// — the identical functions live-validation.mjs and the hermetic
// dat-replication.test.mjs/negative-controls.test.mjs already exercise) but
// adds store-writing and full dependency injection (mirroring evals/run.mjs
// main()'s own deps pattern: runSpecFn/store/getEngineVersion), so
// evals/run.mjs's `--phase 0` wiring — and this module's own tests — can
// drive it without ever touching the network.
//
// ── Cost ledger, not a dollar figure ────────────────────────────────────────
// Each stored row's costRows carries `{ model, input_tokens }` (via
// lib/accounting.mjs costRow() — embeddings have no output tokens) computed
// from the DELTA in `embedder.usage.total_tokens` around exactly the calls
// that control makes, on the SAME embedder instance (usage accumulates
// cumulatively across .embed() calls) — never a derived dollar amount; see
// lib/accounting.mjs / lib/store.mjs headers for why cost_usd is refused
// outright.

import { costRow } from "../../lib/accounting.mjs";
import { voyageEmbedder } from "./embedder.mjs";
import { datReplication as datReplicationDefault, negativeControls as negativeControlsDefault, randomPoolVerdict } from "./validation.mjs";
import { RANDOM_TEXT_POOL, DUPLICATE_POOL } from "./fixtures/control-texts.mjs";
import { VOYAGE_CLUSTER_DISTANCE_THRESHOLD } from "./voyage-calibration.mjs";

export const DAT_REPLICATION_KEY = "phase0/dat-replication";
export const NEGATIVE_CONTROLS_KEY = "phase0/negative-controls";

/**
 * Run Phase 0 (the three controls in scope for issue #48) against a live
 * embedder and persist both results to `store`.
 *
 * @param {object} deps
 * @param {string} deps.apiKey  required, never invented/defaulted — same
 *   contract as ./embedder.mjs voyageEmbedder / ./live-validation.mjs.
 * @param {{ put: Function }} deps.store  a lib/store.mjs ResultsStore (or a
 *   test double with the same `.put()` contract).
 * @param {(opts?: object) => object} [deps.embedderFactory]  defaults to
 *   voyageEmbedder — injectable so tests never touch the network.
 * @param {Function} [deps.datReplicationFn]  defaults to
 *   ./validation.mjs datReplication — injectable so a test can assert
 *   exactly what this module passes it without embedding real text.
 * @param {Function} [deps.negativeControlsFn]  defaults to
 *   ./validation.mjs negativeControls — injectable for the same reason.
 *   THE INJECTION POINT THIS MODULE'S OWN TEST USES to prove the Voyage
 *   threshold (not the MiniLM one) is what actually reaches negativeControls.
 * @param {() => string} [deps.now]  defaults to `() => new Date().toISOString()`
 *   — injectable so tests get a deterministic timestamp.
 * @returns {Promise<{
 *   dat: object, controls: object,
 *   duplicatePassed: boolean, randomVerdict: object,
 *   allPassed: boolean, embedderId: string, totalTokens: number,
 *   threshold: number,
 * }>}
 */
export async function runPhase0(deps) {
  const {
    apiKey,
    store,
    embedderFactory = voyageEmbedder,
    datReplicationFn = datReplicationDefault,
    negativeControlsFn = negativeControlsDefault,
    now = () => new Date().toISOString(),
  } = deps || {};

  if (!apiKey) {
    throw new Error(
      "phase0.mjs runPhase0: apiKey is required. Phase 0 calls the live Voyage API and never invents or " +
        "defaults a key — pass VOYAGE_API_KEY explicitly.",
    );
  }
  if (!store || typeof store.put !== "function") {
    throw new Error("phase0.mjs runPhase0: store (a lib/store.mjs ResultsStore) is required");
  }

  const embedder = embedderFactory({ apiKey });

  // ── DAT replication ────────────────────────────────────────────────────
  const dat = await datReplicationFn(embedder);
  const datTokens = embedder.usage.total_tokens;

  store.put({
    key: DAT_REPLICATION_KEY,
    result: { ...dat },
    resolvedModels: { embedder: embedder.modelId },
    accounting: { state: "completed" },
    costRows: [
      costRow({
        cellKey: DAT_REPLICATION_KEY,
        timestamp: now(),
        billing_mode: "api",
        model: embedder.modelId,
        input_tokens: datTokens,
      }),
    ],
  });

  // ── Negative controls (duplicate pool + random-text pool), Voyage-calibrated
  // threshold — issue #42 / Appendix B item 8. NOT negativeControlsFn's own
  // MiniLM default (see ./validation.mjs negativeControls header: the
  // default threshold is a MiniLM-space number, only correct for the
  // hermetic fixture-embedder call sites; a live-embedder caller like this
  // one MUST pass the calibrated one explicitly).
  const controlsTokensBefore = embedder.usage.total_tokens;
  const controls = await negativeControlsFn(embedder, { threshold: VOYAGE_CLUSTER_DISTANCE_THRESHOLD });
  const controlsTokens = embedder.usage.total_tokens - controlsTokensBefore;

  const duplicatePassed = controls.duplicate.distinctK === 1 && controls.duplicate.diversity < 0.05;
  const randomVerdict = randomPoolVerdict({
    distinctK: controls.random.distinctK,
    diversity: controls.random.diversity,
    poolSize: RANDOM_TEXT_POOL.length,
    datHigh: dat.high,
    orderingHolds: dat.orderingHolds,
  });

  store.put({
    key: NEGATIVE_CONTROLS_KEY,
    result: {
      threshold: VOYAGE_CLUSTER_DISTANCE_THRESHOLD,
      duplicatePoolSize: DUPLICATE_POOL.length,
      randomPoolSize: RANDOM_TEXT_POOL.length,
      duplicate: { ...controls.duplicate, passed: duplicatePassed },
      random: { ...controls.random, verdict: randomVerdict },
    },
    resolvedModels: { embedder: embedder.modelId },
    accounting: { state: "completed" },
    costRows: [
      costRow({
        cellKey: NEGATIVE_CONTROLS_KEY,
        timestamp: now(),
        billing_mode: "api",
        model: embedder.modelId,
        input_tokens: controlsTokens,
      }),
    ],
  });

  return {
    dat,
    controls,
    duplicatePassed,
    randomVerdict,
    // The DAT-ordering claim is itself a control per the issue's table — it
    // must hold for Phase 0 to pass, same as live-validation.mjs's own gate.
    allPassed: dat.orderingHolds && duplicatePassed && !randomVerdict.failed,
    embedderId: embedder.modelId,
    totalTokens: embedder.usage.total_tokens,
    threshold: VOYAGE_CLUSTER_DISTANCE_THRESHOLD,
  };
}
