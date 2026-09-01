// operational.mjs — parse-failure rate, empty-pool rate, refusal rate, and
// latency p50/p95, computed FROM lib/accounting.mjs's recorded cell states —
// never recomputed independently.
//
// ── Why "never recomputed independently" is load-bearing ───────────────────
// lib/accounting.mjs's RunAccount is the ONE place a cell's terminal state is
// recorded (completed/failed/skipped, with a FAILURE_KINDS classification for
// failures — see that file's header on why the engine's "silently drop a bad
// cell" policy is inverted for the eval harness). If this module re-derived
// "was that a parse failure?" from raw run output instead of reading
// `RunAccount`'s own classification, the two could disagree — e.g. a cell the
// harness classified as `refusal` could get independently re-counted as
// `parse_failure` here because the raw text happened to look unparseable
// too. That would make the operational metrics untrustworthy exactly where
// they matter most (the failure taxonomy is the whole point of §4.3 in the
// pre-registration). So every function below takes a RECONCILED RunAccount
// (or the `states` it produced) as its ONLY source of failure/completion
// facts, and reads `FAILURE_KINDS`-classified kinds rather than re-deriving
// them.
//
// `reconcile()` must have been called (and not thrown) before any function
// here runs — see the guard in `#requireReconciled` — because an unreconciled
// account can have planned cells with no terminal state at all, and computing
// a rate over an incomplete set silently understates it.

import { FAILURE_KINDS } from "../../lib/accounting.mjs";

function requireStates(account) {
  if (!account || !(account.states instanceof Map) || !(account.planned instanceof Set)) {
    throw new Error("operational metrics: expected a lib/accounting.mjs RunAccount instance (or duck-typed equivalent with .planned/.states)");
  }
  if (account.states.size !== account.planned.size) {
    throw new Error(
      "operational metrics: account is not reconciled — call account.reconcile() first. " +
        `${account.planned.size - account.states.size} planned cell(s) have no terminal state, and an ` +
        "operational rate computed over an incomplete set would silently understate the true rate.",
    );
  }
  return account.states;
}

/**
 * Rate of a specific classified failure kind among ALL planned cells (not
 * just among failures) — e.g. "what fraction of the whole run parse-failed,"
 * matching how §4.3 of the pre-registration frames each rate ("fraction of
 * agent replies...", "runs returning...") as a fraction of the total, not a
 * fraction of failures.
 *
 * @param {import("../../lib/accounting.mjs").RunAccount} account  reconciled
 * @param {string} kind  one of lib/accounting.mjs FAILURE_KINDS
 */
export function failureRate(account, kind) {
  if (!FAILURE_KINDS.includes(kind)) {
    throw new Error(`failureRate: '${kind}' is not a recognized FAILURE_KINDS entry from lib/accounting.mjs`);
  }
  const states = requireStates(account);
  let matches = 0;
  for (const s of states.values()) {
    if (s.state === "failed" && s.kind === kind) matches++;
  }
  return matches / states.size;
}

/** Fraction of agent replies from which extractCandidates recovered nothing. */
export function parseFailureRate(account) {
  return failureRate(account, "parse_failure");
}

/** Fraction of runs returning candidates: [] (the IC-08 silent-failure mode). */
export function emptyPoolRate(account) {
  return failureRate(account, "empty_pool");
}

/** Fraction of runs where the model's stop_reason was "refusal". */
export function refusalRate(account) {
  return failureRate(account, "refusal");
}

/**
 * Latency percentiles over COMPLETED cells' recorded `result.latencyMs`.
 * Only completed cells carry a meaningful latency (a failed/skipped cell may
 * have no wall-clock result to report, or one that means something different
 * — e.g. "time until the retry budget was exhausted" is not the same
 * quantity as "time to a successful reply"), so this deliberately does NOT
 * fold failed/skipped cells into the percentile — consistent with treating
 * failures as a separate classified rate (above) rather than mixing them into
 * a latency distribution where they'd either be silently excluded (biasing
 * the distribution optimistic) or need an arbitrary sentinel value (which
 * would bias it in an unprincipled direction). Report both this AND the
 * failure rates side by side — that is the honest picture, not a single
 * blended number.
 *
 * @param {import("../../lib/accounting.mjs").RunAccount} account  reconciled
 * @returns {{ p50: number, p95: number, n: number }} n = number of completed
 *   cells the percentiles were computed over (0 if none — p50/p95 are then
 *   `null`, never a fabricated 0, since "no completions" and "all completions
 *   took 0ms" are different facts)
 */
export function latencyPercentiles(account) {
  const states = requireStates(account);
  const latencies = [];
  for (const s of states.values()) {
    if (s.state !== "completed") continue;
    const ms = s.result && s.result.latencyMs;
    if (typeof ms !== "number" || !Number.isFinite(ms)) {
      throw new Error("latencyPercentiles: a completed cell's result is missing a numeric latencyMs — the harness must record it at completion time");
    }
    latencies.push(ms);
  }
  if (latencies.length === 0) return { p50: null, p95: null, n: 0 };
  latencies.sort((a, b) => a - b);
  const pct = (p) => {
    // Nearest-rank method: simple, deterministic, no interpolation
    // ambiguity to document or get subtly wrong for small n (this study's
    // per-arm n is small — §3.4 — where interpolation choice can visibly
    // shift the reported number).
    const idx = Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1);
    return latencies[Math.max(0, idx)];
  };
  return { p50: pct(50), p95: pct(95), n: latencies.length };
}

/**
 * Convenience bundle of every operational metric §4.3 asks for, computed
 * from one reconciled account in one pass — the natural unit a run report
 * would emit per arm.
 *
 * @param {import("../../lib/accounting.mjs").RunAccount} account  reconciled
 */
export function operationalSummary(account) {
  return {
    parseFailureRate: parseFailureRate(account),
    emptyPoolRate: emptyPoolRate(account),
    refusalRate: refusalRate(account),
    latency: latencyPercentiles(account),
  };
}

// ── Pool-level metrics (issue #45 item 2) ────────────────────────────────────
// docs/PREREGISTRATION.md §4.2's table names two LiveIdeaBench axes —
// `fluency` (count of valid ideas) and `flexibility` (breadth of conceptually
// distinct categories touched) — as things to measure. Both are POOL
// properties by LiveIdeaBench's own definition (arXiv 2412.17596 §3.2), not
// per-idea judgments: fluency is a count OVER a pool, and flexibility is
// explicitly relative to "the pool [an idea] was drawn from". They were
// previously (incorrectly) scored per idea by the judge — evals/judge/score.mjs
// submits exactly ONE candidate per scoring request, so the judge never saw
// the pool and a per-idea "flexibility" score was meaningless (a per-idea
// "fluency" score was trivially constant). Removed from evals/judge/prompt.mjs
// JUDGE_AXES (#45 item 2); recovered here, alongside the account-level §4.3
// metrics above, as what they actually are — pool-level operational metrics.
//
// Same "never recomputed independently" discipline as the rest of this file:
// `poolFluency` takes the pool of ALREADY-EXTRACTED candidates (ideate-core's
// extractCandidates has already dropped anything without a non-empty `.text`
// — see evals/harness/prompts.mjs's header — so a pool's length IS the count
// of valid ideas, no re-validation needed here) and `poolFlexibility` takes
// an ALREADY-COMPUTED distinct_k count (evals/metrics/clustering.mjs
// distinctK) rather than re-embedding/re-clustering — the same pattern
// evals/metrics/diversity.mjs's collapseRate uses, so flexibility and
// distinct_k/collapse-rate always agree on what a cluster is (one shared
// clustering call, not two).

/**
 * Pool-level fluency (LiveIdeaBench) — the count of valid candidate ideas in
 * a pool.
 *
 * @param {Array} pool  a pool of ALREADY-EXTRACTED candidates (each with a
 *   non-empty `.text`, per ideate-core's extractCandidates/buildCandidate)
 * @returns {number}
 */
export function poolFluency(pool) {
  if (!Array.isArray(pool)) {
    throw new Error("poolFluency: pool must be an array of already-extracted candidates");
  }
  return pool.length;
}

/**
 * Pool-level flexibility (LiveIdeaBench) — the breadth of conceptually
 * distinct categories/approaches a pool touches, substituted (like the rest
 * of this study's distinct_k usage — see clustering.mjs's header) by the
 * number of semantic equivalence classes (clusters) the pool's embedded
 * ideas occupy.
 *
 * @param {number} distinctKCount  distinct_k for this pool (clustering.mjs
 *   `distinctK`/`clusterByThreshold(...).k`) — computed ONCE by the caller
 *   and passed in, never recomputed here.
 * @returns {number}
 */
export function poolFlexibility(distinctKCount) {
  if (!Number.isInteger(distinctKCount) || distinctKCount < 0) {
    throw new Error("poolFlexibility: distinctKCount must be a non-negative integer (evals/metrics/clustering.mjs distinctK)");
  }
  return distinctKCount;
}

/**
 * Convenience bundle of both pool-level LiveIdeaBench metrics for one pool,
 * mirroring operationalSummary's "one pass, one report unit" shape.
 *
 * @param {object} o
 *   @param {Array} o.pool               already-extracted candidates
 *   @param {number} o.distinctKCount    this pool's distinct_k (clustering.mjs)
 */
export function poolMetricsSummary({ pool, distinctKCount }) {
  return {
    fluency: poolFluency(pool),
    flexibility: poolFlexibility(distinctKCount),
  };
}
