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
// ── Supersedes live-validation.mjs (issue #20), now deleted ────────────────
// live-validation.mjs ran these same three controls live and reported
// pass/fail to the console, but never persisted anything and was not
// deps-injectable, so it could not be exercised hermetically end-to-end and
// its own gating logic (the duplicate-pool bound in particular) had no
// mutation-tested coverage. Rather than maintain two parallel
// implementations of the same live check that could silently drift, it was
// deleted (PR #69 fix round, Quine review) in favor of this module, which
// does everything it did (same shared validation.mjs logic — datReplication/
// negativeControls/randomPoolVerdict/duplicatePoolVerdict — the identical
// functions the hermetic dat-replication.test.mjs/negative-controls.test.mjs
// exercise) plus store-writing and full dependency injection.
//
// ── Re-run / retry safety (Quine finding, PR #69 fix round) ────────────────
// A prior version of this module keyed both stored rows with FIXED constant
// keys ("phase0/dat-replication", "phase0/negative-controls") while each
// row's costRow carried a caller-supplied wall-clock timestamp. Two
// consequences, both bad for a gate registered as "all controls pass, or
// stop": (1) a legitimate re-run against the same store threw, because the
// new row's timestamp differed from the old one and lib/store.mjs's
// append-only put() rejects a same-key write with different content; (2) a
// PARTIAL failure (DAT succeeds and is stored, negativeControls then throws
// on a 429/socket reset) left Phase 0 permanently un-retryable, because the
// retry's DAT row would again collide with the orphaned one under the same
// fixed key — and ResultsStore has no delete, so recovery would mean
// hand-editing index.jsonl or discarding the whole store.
//
// The fix: keys carry a RUN DISCRIMINATOR. `runId` is captured ONCE, at the
// top of runPhase0, and reused for the key suffix of BOTH rows, both
// costRows' `timestamp`, and both rows' `storedAt` — so a single Phase 0
// invocation is internally consistent, but every DISTINCT invocation
// (whether a deliberate re-run or a retry after a partial failure) gets a
// fresh runId and therefore fresh keys. This means:
//   - A retry after a partial failure never collides with the orphaned row
//     from the failed attempt — it simply writes new rows under a new
//     runId. The orphaned single-DAT-row run stays in the store, visibly
//     incomplete (no matching negative-controls row under the same runId)
//     — legible without needing a delete API.
//   - A deliberate re-run is treated the same as a study's own additive
//     design already treats every other repeated measurement (see
//     lib/manifest.mjs / lib/store.mjs headers on replicates): a NEW row,
//     never a same-key overwrite attempt.
// This was chosen over the two alternatives Quine also named (an explicit
// idempotent-write path, or deferring both writes to the very end so a
// partial failure never touches the store at all) because it solves BOTH
// the collision problem AND the partial-failure problem with one change,
// requires no new store API, and matches the store's own "additive, keyed,
// never silently overwritten" philosophy already used everywhere else in
// this repo.
//
// ── Cost ledger, not a dollar figure ────────────────────────────────────────
// Each stored row's costRows carries `{ model, input_tokens }` (via
// lib/accounting.mjs costRow() — embeddings have no output tokens) computed
// from the DELTA in `embedder.usage.total_tokens` around exactly the calls
// that control makes, on the SAME embedder instance (usage accumulates
// cumulatively across .embed() calls) — never a derived dollar amount; see
// lib/accounting.mjs / lib/store.mjs headers for why cost_usd is refused
// outright.
//
// ── Failure legibility (Quine finding) ──────────────────────────────────────
// A row's `accounting.state` is always "completed" here (the MEASUREMENT
// completed — this harness never silently drops a control the way
// ideate-core's engine drops a failing agent) even when the control's
// scientific verdict is a FAIL; that verdict lives in `result`. But issue
// #48 AC1 requires the failure to be "recorded", and a reader scanning
// results/index.jsonl (lib/store.mjs's cheap, body-free index — see that
// file's header on why list()/keys() never open a body) could not
// previously tell a passed Phase 0 run from a failed one without opening
// both bodies. `cfg: { passed, runId }` is attached to both rows precisely
// because `cfg` is index-visible metadata (see lib/store.mjs put()'s
// `entry.cfg = record.cfg`), so `store.list()` alone answers "did this run
// pass?" for each row.

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { costRow } from "../../lib/accounting.mjs";
import { voyageEmbedder } from "./embedder.mjs";
import {
  datReplication as datReplicationDefault,
  negativeControls as negativeControlsDefault,
  randomPoolVerdict,
  duplicatePoolVerdict,
} from "./validation.mjs";
import { RANDOM_TEXT_POOL, DUPLICATE_POOL } from "./fixtures/control-texts.mjs";
import { VOYAGE_CLUSTER_DISTANCE_THRESHOLD, VOYAGE_CALIBRATION_RECORD } from "./voyage-calibration.mjs";

export const DAT_REPLICATION_KEY_PREFIX = "phase0/dat-replication";
export const NEGATIVE_CONTROLS_KEY_PREFIX = "phase0/negative-controls";

/** Build a run-discriminated store key: `<prefix>@<runId>`. Exported so a
 *  caller that already knows a run's `runId` (e.g. from a prior summary) can
 *  reconstruct its keys without guessing the separator. */
export function phase0Key(prefix, runId) {
  return `${prefix}@${runId}`;
}

/** Real (non-hermetic) git SHA lookup — the default `getGitSha`. Soft-fails
 *  to "unknown" rather than throwing: provenance is a nice-to-have on a
 *  stored row, and a git lookup failure (detached worktree oddities, no git
 *  binary) must never abort an otherwise-successful live Phase 0 run over a
 *  cosmetic field. */
function realGetGitSha() {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

/**
 * Run Phase 0 (the three controls in scope for issue #48) against a live
 * embedder and persist both results to `store`.
 *
 * @param {object} deps
 * @param {string} deps.apiKey  required, never invented/defaulted — same
 *   contract as ./embedder.mjs voyageEmbedder.
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
 *   — injectable so tests get a deterministic timestamp. ALSO used as the
 *   run discriminator embedded in both store keys (see file header).
 * @param {() => string} [deps.getGitSha]  defaults to a real `git rev-parse
 *   HEAD` (soft-fails to "unknown") — injectable so tests never touch git.
 * @returns {Promise<{
 *   dat: object, controls: object,
 *   duplicatePassed: boolean, dupVerdict: object, randomVerdict: object,
 *   allPassed: boolean, embedderId: string, totalTokens: number,
 *   threshold: number, runId: string, datKey: string, controlsKey: string,
 *   gitSha: string,
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
    getGitSha = realGetGitSha,
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

  // Fail fast, before any embed() call, if this embedder isn't the one the
  // registered threshold was actually calibrated against (issue #42) — using
  // VOYAGE_CLUSTER_DISTANCE_THRESHOLD against a DIFFERENT embedder's vector
  // space would silently validate the wrong cut, exactly the defect #42
  // fixes and #48 must not reintroduce.
  if (embedder.modelId !== VOYAGE_CALIBRATION_RECORD.embedderId) {
    throw new Error(
      `phase0.mjs runPhase0: embedder.modelId ('${embedder.modelId}') does not match the embedder the ` +
        `registered threshold was calibrated against ('${VOYAGE_CALIBRATION_RECORD.embedderId}', see ` +
        "voyage-calibration.mjs) — refusing to run Phase 0 against a mismatched embedder.",
    );
  }

  // `timestamp` is a real ISO 8601 instant (costRow's contract) captured
  // ONCE and reused for both costRows' `timestamp` and both rows'
  // `storedAt`. `runId` adds a random suffix on top of it purely for KEY
  // uniqueness: two invocations landing in the SAME millisecond (trivially
  // possible with a mocked/injected `now` under `node --test`, and not
  // provably impossible even against the real Date under a fast retry loop)
  // must still get distinct keys, since key collision -- not the timestamp
  // value itself -- is the actual bug this fix exists to prevent. See file
  // header "Re-run / retry safety".
  const timestamp = now();
  const runId = `${timestamp}-${randomUUID().slice(0, 8)}`;
  const gitSha = getGitSha();
  const datKey = phase0Key(DAT_REPLICATION_KEY_PREFIX, runId);
  const controlsKey = phase0Key(NEGATIVE_CONTROLS_KEY_PREFIX, runId);

  // ── DAT replication ────────────────────────────────────────────────────
  const dat = await datReplicationFn(embedder);
  const datTokens = embedder.usage.total_tokens;

  store.put({
    key: datKey,
    result: {
      ...dat,
      // margin (= high - low) is DESCRIPTIVE only — it is not compared
      // against any registered bound, and is fully implied by orderingHolds
      // (both gaps are positive whenever the ordering holds). Stored/printed
      // for diagnostic legibility, never treated as a pass/fail input.
      marginIsDescriptiveOnly: true,
      provenance: { embedderId: embedder.modelId, gitSha },
    },
    resolvedModels: { embedder: embedder.modelId },
    accounting: { state: "completed" },
    cfg: { passed: dat.orderingHolds, runId },
    storedAt: timestamp,
    costRows: [
      costRow({
        cellKey: datKey,
        timestamp,
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

  const dupVerdict = duplicatePoolVerdict({ distinctK: controls.duplicate.distinctK, diversity: controls.duplicate.diversity });
  const duplicatePassed = dupVerdict.passed;
  const randomVerdict = randomPoolVerdict({
    distinctK: controls.random.distinctK,
    diversity: controls.random.diversity,
    poolSize: RANDOM_TEXT_POOL.length,
    datHigh: dat.high,
    orderingHolds: dat.orderingHolds,
  });

  const controlsPassed = duplicatePassed && !randomVerdict.failed;

  store.put({
    key: controlsKey,
    result: {
      threshold: VOYAGE_CLUSTER_DISTANCE_THRESHOLD,
      thresholdProvenance: {
        pairSetHash: VOYAGE_CALIBRATION_RECORD.pairSetHash,
        embedderId: VOYAGE_CALIBRATION_RECORD.embedderId,
      },
      duplicatePoolSize: DUPLICATE_POOL.length,
      randomPoolSize: RANDOM_TEXT_POOL.length,
      duplicate: { ...controls.duplicate, passed: duplicatePassed, verdict: dupVerdict },
      random: { ...controls.random, verdict: randomVerdict },
      provenance: { embedderId: embedder.modelId, gitSha },
    },
    resolvedModels: { embedder: embedder.modelId },
    accounting: { state: "completed" },
    cfg: { passed: controlsPassed, runId },
    storedAt: timestamp,
    costRows: [
      costRow({
        cellKey: controlsKey,
        timestamp,
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
    dupVerdict,
    randomVerdict,
    // The DAT-ordering claim is itself a control per the issue's table — it
    // must hold for Phase 0 to pass.
    allPassed: dat.orderingHolds && controlsPassed,
    embedderId: embedder.modelId,
    totalTokens: embedder.usage.total_tokens,
    threshold: VOYAGE_CLUSTER_DISTANCE_THRESHOLD,
    runId,
    datKey,
    controlsKey,
    gitSha,
  };
}
