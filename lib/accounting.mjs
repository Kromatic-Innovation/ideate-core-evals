// accounting.mjs — run reconciliation and the repriceable cost ledger.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// ideate-core's engine deliberately swallows a failing model call and drops that
// agent (robustness: one bad reply must not sink a run). That is correct for the
// ENGINE and wrong for an EVAL: a study whose harness silently drops cells
// reports a mean over "the runs that happened to work", which is a biased sample
// — and it is biased in the worst possible direction, because the cheapest/most
// rate-limited models fail most often and would look artificially good.
//
// So this harness inverts the engine's policy. Every planned cell MUST reach
// exactly one terminal state, and `reconcile()` THROWS if any cell is
// unaccounted for. A failed cell is a datum (see the failure taxonomy in the
// pre-registration), not an absence.
//
// ── Cost ledger (cwc#1639 / cron-fleet#35 / cron-fleet#75) ──────────────────
// Rows record the FACT — tokens x model x timestamp x billing regime — never a
// derived dollar figure. A row carrying `cost_usd` with no model and no token
// counts can never be repriced when rates change, which is the exact defect
// cron-fleet#75 exists to fix. Pricing happens at READ time from a pinned,
// dated rate table.

export const TERMINAL_STATES = ["completed", "failed", "skipped"];

// ── The retryability split (issue #90) ──────────────────────────────────────
// A failure kind answers "what happened". These two sets answer the SECOND,
// separate question the store needs answered: "is this failure a durable fact
// ABOUT THE ARM, or a fact about the weather the night we ran it?"
//
// The distinction is load-bearing because `lib/manifest.mjs`'s
// `planRun(spec, storedKeys)` receives ONLY keys — it structurally cannot see
// `accounting.state`. Once `cell.key` exists in the append-only store AT ALL,
// every future invocation classifies it `reuse`, forever. So "which set is
// this kind in" is exactly "is this cell permanently spent, or re-attemptable
// next run" — and getting it wrong is silent in both directions:
//
//   - A transient fault filed as intrinsic bricks a cell that nothing was
//     ever actually wrong with. Worse, the loss is arm-correlated (a panel
//     arm issues ~5x the generation calls per cell, so it eats rate limits
//     preferentially), which confounds exactly the panel-vs-solo comparison
//     H1 tests. That is the "untracked bias" this module's own header warns
//     about, reached by the back door.
//   - An intrinsic observation filed as transient is retried into silence:
//     an arm that genuinely refuses, or genuinely emits unparseable output,
//     gets re-rolled until it happens to succeed, and the study reports a
//     failure rate of zero for a real behaviour of the model.
//
// Neither set is "less real". Both are recorded as `failed` on the account
// and both count in `summary.byKind`. The split governs PERSISTENCE ONLY:
// see evals/harness/runner.mjs's generation-failure branch.

/**
 * Cell-INTRINSIC failures: observations about the arm's own behaviour on this
 * brief. Re-running the identical cell is expected to reproduce them, so they
 * store as terminal data under `cell.key` and are never re-attempted.
 */
export const INTRINSIC_FAILURE_KINDS = [
  // The model replied and we could not recover candidates from what it said.
  // That is a property of the arm's output format discipline, not of the
  // network — a re-roll would be resampling until the arm looks better.
  "parse_failure",      // model replied, extractCandidates recovered nothing
  // The run completed and produced an empty pool — IC-08's silent mode, and
  // one of the specific behaviours this study exists to measure. Being
  // reworked separately under issue #93; classification unchanged here.
  "empty_pool",         // run returned candidates: [] (the IC-08 silent mode)
  // A refusal is the model's answer, not a fault. Retrying one until it
  // complies would measure our persistence, not the arm's.
  "refusal",            // stop_reason: "refusal"
];

/**
 * TRANSIENT / environmental failures: facts about the run's conditions, not
 * about the arm. These must never brick a cell — the runner keeps `cell.key`
 * out of the store so a later invocation plans it `todo` again, while the
 * money already spent is persisted under an attempt-scoped key.
 */
export const TRANSIENT_FAILURE_KINDS = [
  "rate_limited",       // 429 after retries — the canonical environmental fault
  "timeout",            // the provider was slow tonight; says nothing about the arm
  "transport_error",    // network / 5xx after retries
  // budget_exceeded: the harness stopped the cell to stay under the cap, i.e.
  // "we chose not to spend on this yet" — which becomes false the moment the
  // operator raises the ceiling. The pre-flight admission path in runner.mjs
  // ALREADY keeps a budget skip out of the store for exactly this reason; a
  // provider-reported budget_exceeded is the same judgement arriving one call
  // later, so the two paths agree rather than contradict each other.
  "budget_exceeded",
  // harness_error is OUR bug. It is emphatically not a datum about the arm,
  // and once the bug is fixed the cell must be runnable again — freezing our
  // own defect into the dataset as a permanent property of an arm is the
  // worst outcome available. (The runner's provider-threw path already
  // records this store-absent; this makes that behaviour the stated rule
  // rather than an accident of where the `continue` sits.)
  "harness_error",      // our bug — must be surfaced, never absorbed
];

/**
 * PAYMENT failures (issue #88): the account cannot pay. A third category,
 * because this kind answers the two questions the sets above answer in a
 * combination neither of them can express:
 *
 *   - Is it a fact about the ARM? No. An empty credit balance says nothing
 *     about the model under test, so it must NOT be stored under `cell.key`
 *     — it is kept store-absent exactly like a transient fault, so a run
 *     against a funded account plans the cell `todo` again. (README.md and
 *     docs/retrying-failed-cells.md already name "an empty credit balance"
 *     as a re-attemptable outcome; this makes the classifier agree with them.)
 *   - Is it worth RE-ATTEMPTING, now, in this invocation? No. Every remaining
 *     cell will hit the identical wall, so retrying is not merely wasteful,
 *     it is guaranteed futile. That is what separates it from
 *     TRANSIENT_FAILURE_KINDS, and why `isTransientFailure()` answers `false`
 *     for it: the runner must ABORT the remaining plan (recording each
 *     un-attempted cell as a classified skip) rather than march a ~200-cell
 *     grid into an unpayable account.
 *
 * Membership here is therefore "store-absent AND stop the study", which is a
 * combination neither existing set expresses — hence a set of its own.
 */
export const PAYMENT_FAILURE_KINDS = [
  // A billing/credit/quota refusal from the provider -- Anthropic's HTTP 400
  // `invalid_request_error` carrying "Your credit balance is too low to
  // access the Anthropic API", or OpenAI's `insufficient_quota`. Detected on
  // the response body's error signature, never on status alone (400 and 429
  // are both far too overloaded to key on).
  "payment_required",
];

/** Failure taxonomy. A cell that fails is classified, never discarded.
 *  The union of the three sets above and nothing more — evals/harness/provider.mjs
 *  validates every provider-reported `failureKind` against this list. */
export const FAILURE_KINDS = [
  ...INTRINSIC_FAILURE_KINDS,
  ...TRANSIENT_FAILURE_KINDS,
  ...PAYMENT_FAILURE_KINDS,
];

/**
 * True if `kind` is an environmental fault that must not permanently consume
 * its cell. Unknown kinds answer `false`: a kind nobody classified is treated
 * as terminal, so a taxonomy gap can never silently turn into an infinite
 * retry loop that re-spends real money every invocation.
 *
 * @param {string} kind a FAILURE_KINDS value
 */
export function isTransientFailure(kind) {
  return TRANSIENT_FAILURE_KINDS.includes(kind);
}

/**
 * True if `kind` means "the account cannot pay" (issue #88). Two consequences
 * in evals/harness/runner.mjs, and they must be read together:
 *
 *   1. PERSISTENCE -- treated exactly like a transient fault: nothing is
 *      written under `cell.key`, so a later run against a funded account
 *      re-attempts the cell. The money already spent is preserved under an
 *      attempt-scoped key, same as every other store-absent failure.
 *   2. CONTINUATION -- unlike a transient fault, the runner STOPS. Every
 *      remaining planned cell is recorded `skipped` with a
 *      `payment_required:<provider>` reason, because "we never tried" is the
 *      honest record and 180 identical failures are noise.
 *
 * Unknown kinds answer `false`, for the same fail-safe reason
 * `isTransientFailure()` does: a taxonomy gap must never silently abort a run.
 *
 * @param {string} kind a FAILURE_KINDS value
 */
export function isPaymentFailure(kind) {
  return PAYMENT_FAILURE_KINDS.includes(kind);
}

const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];

/**
 * Build a cost ledger row. Deliberately REFUSES to accept `cost_usd`.
 *
 * @param {object} o
 *   @param {string} o.cellKey
 *   @param {string} o.timestamp        ISO 8601, supplied by the caller (never
 *                                      generated here — a harness that stamps its
 *                                      own time can't be replayed deterministically)
 *   @param {"api"|"subscription"} o.billing_mode
 *   @param {string} [o.model]          for a single-model call
 *   @param {object} [o.tokens_by_model] { modelId: {input_tokens, ...} } for a run
 *                                      spanning models (the mixed-tier arms)
 */
export function costRow({ cellKey, timestamp, billing_mode, model, tokens_by_model, ...tokens }) {
  if (!cellKey) throw new Error("costRow: cellKey is required");
  if (!timestamp) throw new Error("costRow: timestamp is required (caller-supplied, for replayability)");
  if (billing_mode !== "api" && billing_mode !== "subscription") {
    throw new Error(`costRow: billing_mode must be "api" or "subscription", got ${billing_mode}`);
  }
  if ("cost_usd" in tokens || "notional_usd" in tokens) {
    throw new Error(
      "costRow: dollar figures are never stored — the ledger records tokens x model x " +
        "timestamp and pricing is applied at READ time from a dated rate table (cron-fleet#75).",
    );
  }
  if (!model && !tokens_by_model) {
    throw new Error("costRow: one of `model` or `tokens_by_model` is required — a row with neither can never be repriced");
  }

  const row = { cellKey, timestamp, billing_mode };
  if (model) row.model = model;
  if (tokens_by_model) row.tokens_by_model = tokens_by_model;
  for (const f of TOKEN_FIELDS) {
    // null is meaningful: "this producer had no tokens to report" is different
    // from "zero tokens were used". Never coerce one into the other.
    if (f in tokens) row[f] = tokens[f];
  }
  return row;
}

/**
 * Tracks the terminal state of every planned cell and refuses to let one vanish.
 */
export class RunAccount {
  constructor(plannedKeys = []) {
    this.planned = new Set(plannedKeys);
    this.states = new Map(); // key -> { state, kind?, detail? }
    this.ledger = [];
  }

  #assertPlanned(key) {
    if (!this.planned.has(key)) {
      throw new Error(`RunAccount: '${key}' was recorded but never planned — the plan and the run disagree`);
    }
    const prior = this.states.get(key);
    if (prior) {
      throw new Error(`RunAccount: '${key}' already terminal as '${prior.state}'; refusing to overwrite`);
    }
  }

  complete(key, result) {
    this.#assertPlanned(key);
    if (!result || typeof result !== "object") {
      throw new Error(`RunAccount: complete('${key}') needs a result object — a completion with no payload is a silent drop wearing a success label`);
    }
    this.states.set(key, { state: "completed", result });
  }

  fail(key, kind, detail = "") {
    this.#assertPlanned(key);
    if (!FAILURE_KINDS.includes(kind)) {
      throw new Error(`RunAccount: unknown failure kind '${kind}' — classify it or add it to FAILURE_KINDS; an unclassified failure is an untracked bias`);
    }
    this.states.set(key, { state: "failed", kind, detail });
  }

  skip(key, reason) {
    this.#assertPlanned(key);
    if (!reason) throw new Error(`RunAccount: skip('${key}') requires a reason`);
    this.states.set(key, { state: "skipped", detail: reason });
  }

  addCost(row) {
    if (!this.planned.has(row.cellKey)) {
      throw new Error(`RunAccount: cost row references unplanned cell '${row.cellKey}'`);
    }
    this.ledger.push(row);
  }

  /**
   * The gate. Throws unless every planned cell reached exactly one terminal
   * state. Call before writing results or computing any statistic.
   */
  reconcile() {
    const missing = [];
    for (const key of this.planned) if (!this.states.has(key)) missing.push(key);
    if (missing.length) {
      throw new Error(
        `RunAccount.reconcile: ${missing.length} planned cell(s) never reached a terminal state — ` +
          `results would be a biased sample of "the runs that happened to work". Unaccounted: ` +
          missing.slice(0, 5).join(", ") + (missing.length > 5 ? `, …(+${missing.length - 5})` : ""),
      );
    }
    // skippedByReason (issue #85 fix round, PR #86 review): a skip's
    // `detail` is a free-text reason string -- some skip callers append
    // dynamic detail after a colon (e.g. `budget_exceeded:anthropic`,
    // `metrics_failed: pool metrics failed for cell '...': <embedder
    // error message>`), so grouping on the RAW detail string would scatter
    // one logical reason across many buckets (one per distinct provider
    // name, one per distinct embedder error message...). Grouping on the
    // portion BEFORE THE FIRST COLON collapses those back to one category
    // per reason (`budget_exceeded`, `metrics_failed`, `judge_deferred`,
    // ...) while still keeping a completely different reason in its own
    // bucket -- exactly what an operator reading a run summary needs to
    // tell "you hit your spend ceiling" apart from "the embedder is
    // failing", which otherwise land in the same undifferentiated
    // `summary.skipped` count.
    const summary = { planned: this.planned.size, completed: 0, failed: 0, skipped: 0, byKind: {}, skippedByReason: {} };
    for (const { state, kind, detail } of this.states.values()) {
      summary[state] += 1;
      if (state === "failed") summary.byKind[kind] = (summary.byKind[kind] || 0) + 1;
      if (state === "skipped") {
        const category = typeof detail === "string" && detail ? detail.split(":")[0].trim() : "unknown";
        summary.skippedByReason[category] = (summary.skippedByReason[category] || 0) + 1;
      }
    }
    return summary;
  }
}
