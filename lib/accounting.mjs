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

/** Failure taxonomy. A cell that fails is classified, never discarded. */
export const FAILURE_KINDS = [
  "parse_failure",      // model replied, extractCandidates recovered nothing
  "empty_pool",         // run returned candidates: [] (the IC-08 silent mode)
  "refusal",            // stop_reason: "refusal"
  "rate_limited",       // 429 after retries
  "timeout",
  "transport_error",    // network / 5xx after retries
  "budget_exceeded",    // harness stopped the cell to stay under the cap
  "harness_error",      // our bug — must be surfaced, never absorbed
];

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
