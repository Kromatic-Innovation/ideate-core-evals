// runner.mjs — batch-first execution: turn a spec into completed, reconciled
// cells (issue #5).
//
// ── What this module does NOT reimplement ────────────────────────────────────
// Per the issue, this module is glue over three already-merged modules and
// MUST NOT reimplement their logic:
//   - lib/manifest.mjs   planRun(spec, storedKeys) -> {todo, reuse, stale}.
//                         The runner plans with this, nothing else.
//   - lib/store.mjs      ResultsStore -- keys() feeds planRun (resume), put()
//                         persists every completed cell.
//   - lib/accounting.mjs RunAccount -- EVERY planned cell goes through it;
//                         reconcile() gates any write/statistic; FAILURE_KINDS
//                         is the only vocabulary for a failed cell.
//
// ── Batch-first ───────────────────────────────────────────────────────────────
// "Batch-first" means the batch path is the DEFAULT and the design treats
// non-batch as the fallback -- not the reverse. This harness does not call a
// real provider batch endpoint (see evals/harness/provider.mjs's documented
// stubs for where that plugs in); what IS modeled here is the *choice*: every
// provider call carries an explicit `mode` ("batch" unless the caller opts out
// via `batch: false`), so a real adapter reading `opts.mode` is a drop-in, not
// a redesign. Defaulting `batch` to `true` in `runSpec()` is the load-bearing
// bit -- it is what makes batch the default path rather than something a
// caller has to remember to ask for.
//
// ── Pricing via dependency injection ─────────────────────────────────────────
// Issue #7 owns lib/price.mjs (the pinned, dated rate table). This module
// takes a `priceGrid(plannedCells, arms) -> {usd, breakdown}` function as a
// parameter (tests inject a deterministic mock). A small INTERIM estimator is
// provided below as the default when no pricer is injected, clearly labelled
// as a placeholder -- see `interimPriceGrid`.
//
// ── The non-negotiable ────────────────────────────────────────────────────────
// Every planned cell goes through RunAccount. reconcile() is called before any
// result is written to the store or any statistic is computed. A cell skipped
// for budget is recorded via `account.skip(key, "budget_exceeded")` -- never
// silently dropped from the plan.

import { planRun } from "../../lib/manifest.mjs";
import { RunAccount, costRow, TERMINAL_STATES, FAILURE_KINDS, isTransientFailure, isPaymentFailure } from "../../lib/accounting.mjs";
import { assertValidProviderResponse } from "./provider.mjs";
// providerOf/priceRowByProvider (issue #51, per-provider --max-spend): pure
// data-shape utilities, not the interim estimator this module owns -- see
// lib/price.mjs's own header for why the RATE_TABLE-backed pricer stays a
// separate, injectable seam (runnerPriceGrid) rather than being imported
// wholesale here. providerOf/priceRowByProvider carry no rate-table opinion of
// their own (they take one as a parameter), so importing them does not couple
// this module to lib/price.mjs's RATE_TABLE the way importing runnerPriceGrid
// itself would.
// priceRows/priceRowsByProvider (issue #64, cumulative spend ceilings): the
// same read-time pricer the ledger already uses for a report, now used to
// reconstruct spend-to-date from the store's own cost rows before this
// invocation's admission control runs -- see `spendToDate` below.
import { providerOf, priceRowByProvider, priceRows, priceRowsByProvider, RATE_TABLE as DEFAULT_RATE_TABLE } from "../../lib/price.mjs";
// runJudgeMatrix/judgeScoresKey (issue #68): judging has a non-test caller
// here -- runSpec() invokes runJudgeMatrix per completed pool (one generation
// cell IS a pool -- poolKey === cell.key, see evals/judge/matrix.mjs's own
// header) so a single CLI run goes generation -> metrics -> judge -> ledger
// with no manual step. buildJudgeMatrix is imported separately (not only via
// runJudgeMatrix) so this module can check, BEFORE calling anything, which of
// a pool's two judge legs the store already holds a judge-scores record for
// (issue #68 AC4: a resumed run must judge an already-generated-but-unjudged
// pool, and must NOT re-call a leg that's already scored -- meterJudgeCall's
// store.put() would throw on a same-key row with a different timestamp).
import { runJudgeMatrix, judgeScoresKey } from "../judge/score.mjs";
import { buildJudgeMatrix } from "../judge/matrix.mjs";
// clusterByThreshold/poolDiversity/collapseRate/poolMetricsSummary (issue
// #85): pool-level metrics have a non-test caller here -- see
// `computeCellMetrics` below for the money-first-safe wiring into runSpec()'s
// per-cell loop, mirroring how judging (issue #68, see runJudgeMatrix above)
// was wired in. Embedding, clustering, diversity, and the LiveIdeaBench
// fluency/flexibility bundle are ALL computed from ONE clustering call per
// completed cell (never recomputed independently -- see each module's own
// header for why that discipline matters).
import { clusterByThreshold } from "../metrics/clustering.mjs";
import { poolDiversity, collapseRate } from "../metrics/diversity.mjs";
import { poolMetricsSummary } from "../metrics/operational.mjs";

// ── Interim pricing estimator -- INTERIM, superseded by lib/price.mjs in #7 ──
// A minimal per-model token-estimate table so --max-spend/--dry-run have
// something to price against before the real pinned rate table (#7) lands.
// Rates are the ones documented in docs/PREREGISTRATION.md §8.1 (2026-07-30).
// This table is NOT the source of truth for the study's actual cost ledger --
// the ledger records tokens x model x timestamp (lib/accounting.mjs costRow)
// and is repriced at READ time by lib/price.mjs once #7 lands. This estimator
// exists ONLY to give --max-spend a number to compare against pre-flight.
const INTERIM_RATES_USD_PER_MTOK = {
  "claude-opus-5": { in: 5.0, out: 25.0 },
  "claude-sonnet-5": { in: 3.0, out: 15.0 },
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  // OpenAI arms (G, H) now use real, first-party-verified ids and rates (#22 /
  // lib/price.mjs RATE_TABLE). These INTERIM figures remain a coarse pre-flight
  // estimate for --max-spend only (this table is superseded by lib/price.mjs's
  // authoritative RATE_TABLE at read time); they mirror the real rates so the
  // pre-flight projection is not wildly off.
  "gpt-5.6-terra": { in: 2.0, out: 12.0 },
  "gpt-5.6-sol": { in: 5.0, out: 30.0 },
};

// Per-run token estimate from docs/PREREGISTRATION.md §8.2 projection table:
// "~16k input / 9k output tokens (5 agents x 2 rounds...)" for a panel run.
// Solo (Arm A) is matched on total ideas requested but is a single call, so
// it is estimated far lighter -- see §8.2's Arm A row (~$0.02/run batch vs
// ~$0.15/run for D), roughly a 1/6-1/8 share of a full panel's tokens.
const PANEL_INPUT_TOKENS_ESTIMATE = 16000;
const PANEL_OUTPUT_TOKENS_ESTIMATE = 9000;
const SOLO_INPUT_TOKENS_ESTIMATE = 2500;
const SOLO_OUTPUT_TOKENS_ESTIMATE = 1500;
// Anthropic Batch API / OpenAI Batch API: -50%, per §8.1 -- "Evals are
// latency-insensitive -> ideal fit." Batch-first means this discount applies
// by default; single/fallback mode prices at full rate.
const BATCH_DISCOUNT = 0.5;

/**
 * INTERIM default pricer -- see the header comment. Splits a cell's estimated
 * tokens evenly across its arm's model slots (a coarse approximation; the
 * real pricer in #7 will use actual per-model token accounting once the
 * provider adapter reports it).
 *
 * @param {Array} plannedCells   cells from planRun's `todo` list
 * @param {object} arms          arms.config.json's `.arms` map
 * @param {{batch?: boolean}} [opts]
 * @returns {{usd: number, breakdown: Array<{cellKey: string, usd: number}>}}
 */
export function interimPriceGrid(plannedCells, arms, { batch = true } = {}) {
  const discount = batch ? 1 - BATCH_DISCOUNT : 1;
  const breakdown = [];
  let usd = 0;
  for (const cell of plannedCells) {
    const arm = arms[cell.armId];
    if (!arm) {
      throw new Error(`interimPriceGrid: cell '${cell.key}' references unknown arm '${cell.armId}' -- check arms.config.json`);
    }
    const slots = arm.slots || [];
    if (slots.length === 0) {
      // An arm with no model slots prices at exactly $0.00 with no error if
      // left unchecked -- which would let a misconfigured arm (a typo'd or
      // truncated `slots` array in arms.config.json) sail through
      // --max-spend for free instead of surfacing the config error. A
      // pricing bug in a budget-safety gate must fail loud, not fail cheap.
      throw new Error(`interimPriceGrid: arm '${cell.armId}' has no model slots -- check arms.config.json`);
    }
    const isSolo = arm.mode === "solo";
    const totalIn = isSolo ? SOLO_INPUT_TOKENS_ESTIMATE : PANEL_INPUT_TOKENS_ESTIMATE;
    const totalOut = isSolo ? SOLO_OUTPUT_TOKENS_ESTIMATE : PANEL_OUTPUT_TOKENS_ESTIMATE;
    const perSlotIn = totalIn / Math.max(slots.length, 1);
    const perSlotOut = totalOut / Math.max(slots.length, 1);

    let cellUsd = 0;
    // byProvider: same per-slot split runnerPriceGrid computes (issue #51) --
    // this INTERIM pricer is a fallback/default, but a caller that injects
    // it and asks for per-provider ceilings still gets a real, mixed-arm-safe
    // split rather than a flat per-cell assignment.
    const byProvider = {};
    for (const slot of slots) {
      const rate = INTERIM_RATES_USD_PER_MTOK[slot.model];
      if (!rate) {
        throw new Error(`interimPriceGrid: no interim rate for model '${slot.model}' (arm '${cell.armId}') -- add it to INTERIM_RATES_USD_PER_MTOK or wait for lib/price.mjs (#7)`);
      }
      const slotUsd = ((perSlotIn / 1_000_000) * rate.in + (perSlotOut / 1_000_000) * rate.out) * discount;
      cellUsd += slotUsd;
      const provider = providerOf(slot.model);
      byProvider[provider] = (byProvider[provider] || 0) + slotUsd;
    }
    breakdown.push({ cellKey: cell.key, usd: cellUsd, byProvider });
    usd += cellUsd;
  }
  return { usd, breakdown };
}

/**
 * Resolve the model IDs an arm actually ran, keyed by persona slot -- the
 * `resolvedModels` shape ResultsStore.put() requires so a stored cell always
 * records exactly what ran (arms.config.json is config and could change
 * between sessions; the stored record must not depend on it staying stable).
 */
function resolvedModelsFor(arm) {
  const out = {};
  for (const slot of arm.slots || []) {
    // Multiple slots can share a persona name under personaDisabled arms
    // (A'): keep them distinguishable by index so no model silently
    // overwrites another in the record.
    const key = out[slot.persona] === undefined ? slot.persona : `${slot.persona}#${Object.keys(out).length}`;
    out[key] = slot.model;
  }
  return out;
}

/**
 * Build cost rows for a completed cell's tokens, in whatever shape the
 * provider returned (single-model `model` + token fields, or multi-model
 * `tokens_by_model` for the mixed arms) -- costRow() accepts either.
 */
function costRowsFor(cellKey, tokens, timestamp) {
  if (!tokens) return [];
  const billing_mode = "api"; // this study is real metered spend (§7)
  if (tokens.tokens_by_model) {
    return [costRow({ cellKey, timestamp, billing_mode, tokens_by_model: tokens.tokens_by_model })];
  }
  if (tokens.model) {
    return [costRow({ cellKey, timestamp, billing_mode, ...tokens })];
  }
  return [];
}

/**
 * Persist a failed metrics attempt's cost rows under an attempt-scoped key
 * (issue #85 fix round -- PR #86 review) so a transient Voyage failure
 * during pool metrics can never brick the store the way a fixed judge-call
 * key did before #76's fix (mirrors evals/judge/gate.mjs's meterJudgeCall
 * exactly, same attempt-count-from-store-keys discriminator). The CELL
 * ITSELF must stay OUT of the store on a metrics failure -- see the per-cell
 * loop's metrics-failure branch for the full reasoning (lib/manifest.mjs's
 * planRun sees only keys, so a stored `failed` record under cell.key would
 * be permanently unretryable and would correlate cell loss with arm size,
 * confounding H1). This function exists ONLY to make sure the money already
 * spent -- real generation tokens, plus whatever the embedder actually
 * consumed before failing -- is not lost just because the cell itself isn't
 * stored. `store.keys()` is index-only (cheap; lib/store.mjs) and reflects
 * every attempt already durably recorded for this exact cell, including
 * ones from a PRIOR session, so the next attempt number is always correct
 * regardless of process/session boundaries -- exactly meterJudgeCall's own
 * contract.
 *
 * @param {object} store  a lib/store.mjs ResultsStore
 * @param {object} o
 *   @param {{key: string, cfg: string}} o.cell
 *   @param {Array} o.costRows   every costRow() for this attempt (generation
 *     tokens, plus any embedder tokens actually consumed before failing)
 *   @param {string} o.detail    why metrics computation failed
 *   @param {string} o.timestamp ISO 8601 (unused directly here -- costRows
 *     already carry their own timestamps; kept in the signature for symmetry
 *     with the rest of this module's helpers and in case a future caller
 *     needs it for the attempt record itself)
 */
function recordMetricsAttemptFailure(store, { cell, costRows, detail }) {
  // nextAttemptNumber, not a startsWith(...).length count (issue #98): once
  // compaction folds attempts 0..4 into one record, a count answers "1" and
  // collides with the retained attempt 5. See nextAttemptNumber's own doc.
  const attempt = nextAttemptNumber(store, "metrics-attempt", cell.key);
  const key = `metrics-attempt|cell=${cell.key}|attempt=${attempt}`;
  // Self-describing model list, derived from the cost rows themselves
  // rather than requiring a caller to pass resolvedModels separately --
  // this is a side ledger record, not a planned cell, so there is no arm
  // slot config to resolve against.
  const models = new Set();
  for (const row of costRows) {
    if (row.model) models.add(row.model);
    if (row.tokens_by_model) for (const m of Object.keys(row.tokens_by_model)) models.add(m);
  }
  return store.put({
    key,
    armId: "__metrics-attempt__",
    briefId: cell.key,
    replicate: 0,
    cfg: cell.cfg,
    result: { kind: "metrics-attempt", cellKey: cell.key, attempt, detail },
    resolvedModels: { models: [...models] },
    accounting: { state: "failed", kind: "harness_error", detail },
    costRows,
  });
}

/**
 * Persist a failed GENERATION attempt's cost rows under an attempt-scoped key
 * (issue #90) -- the exact counterpart of recordMetricsAttemptFailure above,
 * one door further upstream, and deliberately the SAME mechanism rather than
 * a second pattern.
 *
 * The hazard is identical and the reasoning transfers verbatim: a cell whose
 * generation failed on an ENVIRONMENTAL fault (a 429, a 5xx, a timeout, a
 * zero credit balance, our own bug) must not be written under `cell.key`,
 * because `planRun(spec, storedKeys)` sees only keys and would classify it
 * `reuse` forever after. The store is append-only, and its ONE removal path
 * (`remove()`, issue #98) is reachable only from an explicitly-invoked
 * `--prune`, never from a run. And
 * because a panel arm issues ~5x the generation calls per cell, the loss
 * lands preferentially on panel arms -- an arm-correlated hole in the data
 * that confounds exactly the panel-vs-solo comparison H1 tests.
 *
 * So the cell stays OUT of the store and this record carries the money.
 * `store.keys()` is index-only (cheap; lib/store.mjs) and reflects every
 * attempt already durably recorded for this exact cell INCLUDING ones from a
 * prior session, so the next attempt number is always correct across process
 * boundaries -- meterJudgeCall's own contract, unchanged.
 *
 * Unlike recordMetricsAttemptFailure, this carries the REAL failure kind
 * rather than a constant `harness_error`: this record is the only durable
 * evidence that the cell was ever attempted, so it has to be able to answer
 * an operator asking "why is this cell `todo` again?" with `rate_limited`
 * rather than a generic shrug.
 *
 * @param {object} store  a lib/store.mjs ResultsStore
 * @param {object} o
 *   @param {{key: string, cfg: string}} o.cell
 *   @param {Array}  o.costRows        every costRow() for this attempt
 *   @param {string} o.kind            the FAILURE_KINDS value the provider reported
 *   @param {string} o.detail          the provider's own detail string
 *   @param {object} o.resolvedModels  resolvedModelsFor(arm) -- what actually ran
 */
function recordGenerationAttemptFailure(store, { cell, costRows, kind, detail, resolvedModels }) {
  // nextAttemptNumber, not a startsWith(...).length count (issue #98) -- see
  // recordMetricsAttemptFailure above and nextAttemptNumber's own doc.
  const attempt = nextAttemptNumber(store, "generation-attempt", cell.key);
  const key = `generation-attempt|cell=${cell.key}|attempt=${attempt}`;
  return store.put({
    key,
    // A sentinel armId, exactly like recordMetricsAttemptFailure's -- this is
    // a side ledger record, not a planned cell. It is invisible to planRun()
    // (whose key regex requires a leading `arm=`) and visible to spendToDate()
    // (which sums costRows across every stored body, unfiltered), which is
    // precisely the pair of properties this record needs.
    armId: "__generation-attempt__",
    briefId: cell.key,
    replicate: 0,
    cfg: cell.cfg,
    result: { kind: "generation-attempt", cellKey: cell.key, attempt, failureKind: kind, detail },
    resolvedModels,
    accounting: { state: "failed", kind, detail },
    costRows,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PRUNE + ATTEMPT RETENTION (issue #98)
// ─────────────────────────────────────────────────────────────────────────────
//
// Two loose ends from #90, and they are the same missing capability: nothing
// could take a record OUT of the store. `lib/store.mjs` now has exactly one
// removal path (`remove()`, see its header); everything below is the policy
// layer that decides WHAT to remove and, far more importantly, guarantees the
// money never goes with it.
//
// ── The one invariant ───────────────────────────────────────────────────────
// A prune must never make the study look cheaper than it was. `spendToDate()`
// sums the `costRows` of every stored body, so removing a body removes its
// money unless something else already carries it. Both operations below are
// built around that:
//
//   EVICT   — a cell record leaves the store so `planRun` plans it `todo`
//             again. Its cost rows are first RE-HOMED under a
//             `pruned-cell|cell=…|pruned=N` record, which is exactly what
//             #90 does for a live transient failure, applied retroactively.
//             A legacy store is thereby not merely repaired, it is brought
//             to the shape #90 would have written in the first place.
//   COMPACT — several attempt records for one cell are folded into ONE
//             record whose cost rows are the per-(cell, billing mode, model)
//             SUM of theirs. Count falls; money is identical.
//
// ── Why compaction, and not a count cap ─────────────────────────────────────
// The obvious bounded policy — "keep the newest 5 attempts, drop the rest" —
// is wrong here for a reason specific to what an attempt record IS. The
// record exists BECAUSE its spend must outlive the cell; dropping the oldest
// drops real money and under-reports the study. Folding keeps every token,
// under the same model and billing mode, in one row per (cell, mode, model)
// — so the record count per cell is bounded by the retention window and the
// ROW count per compacted record is bounded by the arm's model set, both
// constant rather than linear in the number of bad nights.
//
// ── Why folding is verified, not assumed ────────────────────────────────────
// Pricing is linear in tokens for a fixed (model, timestamp, billing mode),
// so summing-then-pricing normally equals pricing-then-summing. "Normally":
// `lib/price.mjs`'s `resolveBaseRate` picks an INTRO rate for rows stamped
// at or before a model's `introUntil`, so a group whose rows straddle that
// boundary would reprice differently under any single collapsed timestamp.
// Rather than teach this module the rate table's internal shape, `foldCostRows`
// PRICES BOTH FORMS and only returns the folded rows if the totals match.
// A group that would reprice differently is passed through unfolded — the
// bound degrades, the ledger never does.
//
// ── Why removal is never on the run path ────────────────────────────────────
// `runSpec()` does not call any of this. It WARNS (see the retention warning
// near the end of the run) and names the command. Deletion stays an
// explicitly-invoked operator action — `node evals/run.mjs --prune --apply`,
// dry-run by default — because a mutation that a normal invocation can reach
// is a mutation that will eventually happen when nobody meant it to.

/** Attempt-record families this module compacts. `judge-call` records
 *  (evals/judge/gate.mjs) have the same shape and the same unbounded-growth
 *  property, but their attempt numbering lives in that module and derives
 *  from a raw `startsWith(...).length` count that compaction would break —
 *  bringing them in means changing gate.mjs, which is deliberately out of
 *  scope here. Noted in docs/retrying-failed-cells.md as a known follow-up. */
export const ATTEMPT_FAMILIES = ["generation-attempt", "metrics-attempt"];

/** Family carrying cost rows salvaged off a cell record the prune evicted. */
const PRUNED_CELL_FAMILY = "pruned-cell";

/** Default retention window: how many attempt records per cell per family
 *  survive a compaction un-folded. 5 is "enough to read the last few bad
 *  nights out of the store by hand" — the diagnostic value of an individual
 *  attempt record decays fast, while its money does not decay at all. */
export const DEFAULT_ATTEMPT_RETENTION = 5;

/** The exact `cellKey()` grammar from lib/manifest.mjs. Selection MUST go
 *  through this and never through `entry.cfg`: a real store's `cfg` is not
 *  always a config hash (a judge-call record's `cfg` is the JUDGE MODEL ID,
 *  a phase0 record's is an object — both observed on the #8 smoke store, see
 *  evals/analysis/storeConfig.mjs). Matching the key grammar makes every
 *  non-cell record structurally unselectable by a cell prune, rather than
 *  relying on a downstream guard to catch it. */
const CELL_KEY_RE = /^arm=([^|]+)\|brief=([^|]+)\|rep=(\d+)\|cfg=([^|]+)$/;

/** Parse a stored key as a study cell, or null if it is anything else. */
export function parseCellKey(key) {
  const m = CELL_KEY_RE.exec(key);
  if (!m) return null;
  return { armId: m[1], briefId: m[2], replicate: Number(m[3]), cfg: m[4] };
}

/**
 * Parse a stored key as an attempt record of one of ATTEMPT_FAMILIES, raw or
 * compacted. Returns `{ family, cellKey, through, compacted }` or null.
 *
 * `through` is the HIGHEST attempt number the record accounts for — the
 * attempt number itself for a raw record, the fold's upper bound for a
 * compacted one. That single field is what makes ordering, next-number
 * derivation and crash recovery all work off one comparison.
 *
 * Parsed by suffix position, never by a greedy regex: the cell key sits in
 * the MIDDLE of these keys and itself contains `|` and `=`.
 */
export function parseAttemptKey(key) {
  for (const family of ATTEMPT_FAMILIES) {
    const rawPrefix = `${family}|cell=`;
    if (key.startsWith(rawPrefix)) {
      const at = key.lastIndexOf("|attempt=");
      if (at <= rawPrefix.length - 1) return null;
      const n = Number(key.slice(at + "|attempt=".length));
      if (!Number.isInteger(n) || n < 0) return null;
      return { family, cellKey: key.slice(rawPrefix.length, at), through: n, compacted: false };
    }
    const compactedPrefix = `${family}-compacted|cell=`;
    if (key.startsWith(compactedPrefix)) {
      const at = key.lastIndexOf("|through=");
      if (at <= compactedPrefix.length - 1) return null;
      const n = Number(key.slice(at + "|through=".length));
      if (!Number.isInteger(n) || n < 0) return null;
      return { family, cellKey: key.slice(compactedPrefix.length, at), through: n, compacted: true };
    }
  }
  return null;
}

/**
 * The next attempt number for `cellKey` in `family`: one past the highest
 * attempt any stored record accounts for, across BOTH the raw and compacted
 * shapes.
 *
 * This replaces the pre-#98 `store.keys().filter(startsWith).length` count,
 * and the replacement is required rather than cosmetic: once compaction
 * folds attempts 0..4 into a single record, a COUNT says "1 record, so the
 * next attempt is 1" — colliding with the retained attempt 5. Deriving from
 * the maximum is correct under every mix of folded and unfolded records, and
 * is identical to the old count for the un-compacted 0..n-1 case.
 *
 * `store.keys()` is index-only (cheap; lib/store.mjs) and reflects every
 * attempt durably recorded for this cell INCLUDING ones from a prior
 * session, so the number is correct across process boundaries.
 */
export function nextAttemptNumber(store, family, cellKey) {
  let max = -1;
  for (const key of store.keys()) {
    const parsed = parseAttemptKey(key);
    if (!parsed || parsed.family !== family || parsed.cellKey !== cellKey) continue;
    if (parsed.through > max) max = parsed.through;
  }
  return max + 1;
}

const FOLDABLE_TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];

/** True if every present token field on `tokens` is a finite number. A null
 *  is MEANINGFUL in this ledger ("this producer had no tokens to report" is
 *  not "zero tokens were used" — see costRow()'s own comment), so a row
 *  carrying one is never folded; it passes through untouched. */
function foldableTokens(tokens) {
  for (const f of FOLDABLE_TOKEN_FIELDS) {
    if (!(f in tokens)) continue;
    if (typeof tokens[f] !== "number" || !Number.isFinite(tokens[f])) return false;
  }
  return true;
}

function sumTokensInto(target, tokens) {
  for (const f of FOLDABLE_TOKEN_FIELDS) {
    if (!(f in tokens)) continue;
    target[f] = (target[f] || 0) + tokens[f];
  }
}

/**
 * Fold cost rows so the record count stops growing with the number of
 * attempts, WITHOUT changing what the ledger prices.
 *
 * Rows are grouped by the tuple that pricing is a linear function of —
 * `(cellKey, billing_mode, model)` for a single-model row, and
 * `(cellKey, billing_mode, <the exact model key-set>)` for a `tokens_by_model`
 * row. A `tokens_by_model` row is never reshaped into N single-model rows:
 * that would be an untested assumption about how `priceRow` treats the two
 * shapes, and this function's whole job is to not assume.
 *
 * The folded set is then PRICED and compared against the original. If the
 * two disagree by more than floating-point noise — the `introUntil` boundary
 * case described in this section's header — the ORIGINAL rows are returned
 * unchanged. The bound is best-effort; the ledger is not.
 *
 * @returns {{rows: Array, folded: boolean, reason?: string}}
 */
export function foldCostRows(rows, rateTable = DEFAULT_RATE_TABLE, { batch = true } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return { rows: rows || [], folded: false, reason: "nothing to fold" };

  const groups = new Map(); // groupKey -> { row, timestamp }
  const passthrough = [];
  for (const row of rows) {
    const { cellKey, timestamp, billing_mode, model, tokens_by_model, ...tokens } = row;
    if (model && !tokens_by_model && foldableTokens(tokens)) {
      const gk = JSON.stringify(["model", cellKey, billing_mode, model]);
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { cellKey, billing_mode, model, timestamp, tokens: {} }));
      if (timestamp > g.timestamp) g.timestamp = timestamp;
      sumTokensInto(g.tokens, tokens);
      continue;
    }
    if (tokens_by_model && !model && Object.values(tokens_by_model).every((t) => t && typeof t === "object" && foldableTokens(t))) {
      const models = Object.keys(tokens_by_model).sort();
      const gk = JSON.stringify(["by_model", cellKey, billing_mode, models]);
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { cellKey, billing_mode, tokens_by_model: {}, timestamp }));
      if (timestamp > g.timestamp) g.timestamp = timestamp;
      for (const [m, t] of Object.entries(tokens_by_model)) {
        g.tokens_by_model[m] = g.tokens_by_model[m] || {};
        sumTokensInto(g.tokens_by_model[m], t);
      }
      continue;
    }
    // A null token count, a row carrying BOTH model and tokens_by_model, a
    // shape this function does not recognise: never guessed at, never
    // dropped — carried through verbatim.
    passthrough.push(row);
  }

  const foldedRows = [...passthrough];
  for (const g of groups.values()) {
    foldedRows.push(
      g.tokens_by_model
        ? costRow({ cellKey: g.cellKey, timestamp: g.timestamp, billing_mode: g.billing_mode, tokens_by_model: g.tokens_by_model })
        : costRow({ cellKey: g.cellKey, timestamp: g.timestamp, billing_mode: g.billing_mode, model: g.model, ...g.tokens }),
    );
  }
  if (foldedRows.length >= rows.length) return { rows, folded: false, reason: "fold would not reduce the row count" };

  // ── Verify, then commit ───────────────────────────────────────────────────
  const before = priceRows(rows, rateTable, { batch });
  const after = priceRows(foldedRows, rateTable, { batch });
  const beforeByProvider = priceRowsByProvider(rows, rateTable, { batch });
  const afterByProvider = priceRowsByProvider(foldedRows, rateTable, { batch });
  const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const providers = new Set([...Object.keys(beforeByProvider.byProvider), ...Object.keys(afterByProvider.byProvider)]);
  const priceHolds =
    close(before.totalUsd, after.totalUsd) &&
    close(before.totalNotionalUsd, after.totalNotionalUsd) &&
    close(beforeByProvider.excludedNonProviderUsd, afterByProvider.excludedNonProviderUsd) &&
    [...providers].every((p) => close(beforeByProvider.byProvider[p] || 0, afterByProvider.byProvider[p] || 0));
  if (!priceHolds) {
    return {
      rows,
      folded: false,
      reason:
        "folding these rows would reprice them (a group straddles a dated rate change, e.g. lib/price.mjs's introUntil) " +
        "-- kept unfolded rather than altering the ledger",
    };
  }
  return { rows: foldedRows, folded: true };
}

/** Sorted-key JSON, matching how lib/store.mjs canonicalizes a body before
 *  writing it — so a record built here compares equal to its own stored
 *  form regardless of property insertion order. */
function canonicalJson(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = v[k];
      return out;
    }
    return v;
  });
}

/** Sort cost rows into a canonical order so a compacted record's body is a
 *  pure function of what it accounts for. Without this, re-running a prune
 *  over an already-compacted record could produce the same rows in a
 *  different array order, which `put()` (its canonical JSON sorts OBJECT
 *  keys, never ARRAY order) would correctly reject as different content. */
function sortRowsCanonically(rows) {
  return [...rows].sort((a, b) => {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

/**
 * Plan a prune. Reads the store; writes nothing. This IS the dry-run — the
 * `--prune` CLI reports exactly this object and `pruneStore()` applies
 * exactly this object, so what an operator is shown and what actually
 * happens cannot drift apart.
 *
 * @param {object} store  a lib/store.mjs ResultsStore
 * @param {object} [opts]
 *   @param {string}   [opts.configHash] select cells under this cfg only
 *   @param {string[]} [opts.armIds]     select cells for these arms only
 *   @param {string[]} [opts.briefIds]   select cells for these briefs only
 *   @param {string[]} [opts.kinds]      select cells whose stored
 *     `accounting.kind` is one of these (requires reading those bodies — the
 *     index carries `state`, not `kind`)
 *   @param {string[]} [opts.states=["failed"]] select cells in these terminal
 *     states. Defaults to `failed` ALONE: the eviction case this exists for
 *     is a legacy transient failure, and a default that could reach a
 *     completed cell is the wrong default for a delete.
 *   @param {boolean}  [opts.allowCompleted=false] permit evicting a completed
 *     cell. Off by default; lib/store.mjs's remove() refuses independently.
 *   @param {number|null} [opts.keepAttempts=DEFAULT_ATTEMPT_RETENTION] how
 *     many attempt records per (cell, family) survive un-folded. `null`
 *     disables compaction entirely.
 * @returns {{evictions: Array, refused: Array, compactions: Array,
 *   keysBefore: number, keysAfter: number, selectorsGiven: boolean}}
 */
export function planPrune(store, opts = {}) {
  const {
    configHash,
    armIds,
    briefIds,
    kinds,
    states,
    allowCompleted = false,
    keepAttempts = DEFAULT_ATTEMPT_RETENTION,
  } = opts;

  const selectorsGiven = Boolean(configHash || armIds || briefIds || kinds || states);
  const wantStates = states || ["failed"];
  const entries = store.list();

  // ── Eviction: cell records that should leave so planRun re-plans them ────
  const evictions = [];
  const refused = [];
  if (selectorsGiven) {
    for (const entry of entries) {
      // Key grammar, NOT entry.cfg — see CELL_KEY_RE's comment. A judge-call
      // record whose `cfg` happens to be a judge model id, or a phase0
      // record whose `cfg` is an object, is not a cell and can never be
      // selected here.
      const cell = parseCellKey(entry.key);
      if (!cell) continue;
      if (configHash && cell.cfg !== configHash) continue;
      if (armIds && !armIds.includes(cell.armId)) continue;
      if (briefIds && !briefIds.includes(cell.briefId)) continue;
      if (!wantStates.includes(entry.state)) continue;

      let body = null;
      if (kinds) {
        body = store.get(entry.key);
        if (!kinds.includes(body.accounting && body.accounting.kind)) continue;
      }
      if (!body) body = store.get(entry.key);

      const record = {
        key: entry.key,
        state: entry.state,
        kind: (body.accounting && body.accounting.kind) || null,
        detail: (body.accounting && body.accounting.detail) || "",
        cfg: cell.cfg,
        armId: cell.armId,
        briefId: cell.briefId,
        replicate: cell.replicate,
        // storedAt identifies this PHYSICAL record, and that is what makes
        // the salvage idempotent without being wrong -- see
        // salvageEvictedCellSpend's own doc for why content alone cannot
        // distinguish a crash-retry from a genuine re-run.
        storedAt: entry.storedAt,
        costRows: body.costRows || [],
        resolvedModels: body.resolvedModels || {},
      };
      if (entry.state === "completed" && !allowCompleted) {
        // Reported, never silently skipped and never silently deleted. A
        // completed cell is paid-for data; the operator has to say so.
        refused.push({ ...record, reason: "completed — pass --allow-completed to evict paid-for data" });
        continue;
      }
      evictions.push(record);
    }
  }

  // ── Compaction: bound the attempt records per (cell, family) ─────────────
  const compactions = [];
  if (keepAttempts !== null && keepAttempts !== undefined) {
    if (!Number.isInteger(keepAttempts) || keepAttempts < 1) {
      throw new Error(`planPrune: keepAttempts must be a positive integer (or null to disable compaction), got ${keepAttempts}`);
    }
    const byCellFamily = new Map();
    for (const entry of entries) {
      const parsed = parseAttemptKey(entry.key);
      if (!parsed) continue;
      const gk = `${parsed.family} ${parsed.cellKey}`;
      if (!byCellFamily.has(gk)) byCellFamily.set(gk, []);
      byCellFamily.get(gk).push({ ...parsed, key: entry.key });
    }
    for (const records of byCellFamily.values()) {
      if (records.length <= keepAttempts) continue;
      // Ordered by what each record accounts for. A compacted record always
      // folds FROM zero, so ties (a crash-interrupted prune leaving both a
      // compacted `through=4` and a raw `attempt=4`) sort the compacted one
      // first: it subsumes the raw, and the raw contributes no rows below.
      records.sort((a, b) => a.through - b.through || (a.compacted === b.compacted ? 0 : a.compacted ? -1 : 1));
      const foldSet = records.slice(0, records.length - keepAttempts);
      const through = Math.max(...foldSet.map((r) => r.through));
      const family = foldSet[0].family;
      const cellKey = foldSet[0].cellKey;
      const newKey = `${family}-compacted|cell=${cellKey}|through=${through}`;

      // Row selection, and the crash-recovery rule in one line: a compacted
      // record covers [0..through], so any RAW record at or below the
      // highest compacted `through` in the fold set has already had its
      // money counted. Include it in the removal, exclude it from the rows.
      // Only the highest compacted record contributes rows — a lower one is
      // a subset of it by construction.
      const compactedInFold = foldSet.filter((r) => r.compacted);
      const topCompacted = compactedInFold.length ? compactedInFold[compactedInFold.length - 1] : null;
      const covered = topCompacted ? topCompacted.through : -1;
      const contributors = foldSet.filter((r) => (r.compacted ? r === topCompacted : r.through > covered));

      const rawRows = [];
      const models = new Set();
      let cfg;
      for (const r of contributors) {
        const body = store.get(r.key);
        if (Array.isArray(body.costRows)) rawRows.push(...body.costRows);
        for (const m of Object.values(body.resolvedModels || {})) {
          if (typeof m === "string") models.add(m);
          else if (Array.isArray(m)) for (const x of m) models.add(x);
        }
      }
      for (const entry of entries) {
        if (entry.key === contributors[0].key) cfg = entry.cfg;
      }
      const fold = foldCostRows(rawRows, DEFAULT_RATE_TABLE, { batch: true });
      const removeKeys = foldSet.map((r) => r.key).filter((k) => k !== newKey);
      if (removeKeys.length === 0) continue; // nothing would actually go away

      compactions.push({
        family,
        cellKey,
        through,
        newKey,
        cfg,
        removeKeys,
        keptKeys: records.slice(records.length - keepAttempts).map((r) => r.key),
        rows: sortRowsCanonically(fold.rows),
        rowsBefore: rawRows.length,
        rowsFolded: fold.folded,
        foldSkippedReason: fold.folded ? null : fold.reason,
        models: [...models].sort(),
      });
    }
  }

  const netRemoved =
    evictions.length +
    compactions.reduce((n, c) => n + c.removeKeys.length - (store.has(c.newKey) ? 0 : 1), 0);
  return {
    evictions,
    refused,
    compactions,
    keysBefore: entries.length,
    // Eviction adds one salvage record per evicted cell that carried money.
    keysAfter: entries.length - netRemoved + evictions.filter((e) => e.costRows.length > 0).length,
    selectorsGiven,
  };
}

/**
 * Apply a prune. THE only production caller of `ResultsStore.remove()`.
 *
 * Every removal is money-first, mirroring the ordering evals/judge/gate.mjs
 * already uses for a metered judge call: the record that CARRIES the spend
 * is written before the record that HELD it is removed. A crash in the
 * window over-reports (the same money is briefly in two places) and never
 * under-reports, and re-running the prune converges — the salvage key is
 * derived from the cell's own content, and a re-compaction folds a
 * crash-orphaned raw record's rows out rather than in (see planPrune's
 * `covered` rule). Under-reporting would be permanent and invisible, which
 * is why the ordering is not a matter of taste.
 *
 * After applying, `spendToDate()` is recomputed and compared against the
 * pre-prune figure. A mismatch throws: it means this module has a fold bug,
 * and the operator finds out from the prune rather than from a study that
 * quietly claims to have cost less than it did.
 *
 * @param {object} store  a lib/store.mjs ResultsStore
 * @param {object} [opts] planPrune()'s options, plus:
 *   @param {(msg: string) => void} [opts.log]
 * @returns {{plan: object, spendBefore: object, spendAfter: object,
 *   removed: string[], written: string[], duplicateSpendUsd: number}}
 */
export function pruneStore(store, opts = {}) {
  const { log = () => {} } = opts;
  const plan = planPrune(store, opts);
  const spendBefore = spendToDate(store);

  const removed = [];
  const written = [];
  // Rows this prune knowingly removes as a DUPLICATE rather than as spend:
  // the crash-window repair, where a salvage record for this exact cell
  // record already exists because a previous prune died after writing it and
  // before removing the cell. Both copies were being counted; taking one
  // away is the repair, not a loss. Tracked explicitly so the verification
  // below can still be an equality check on everything else — "spend may go
  // down a bit sometimes" is not an invariant worth having.
  const knownDuplicateRows = [];

  // ── 1. Evict cells, salvaging their spend first ─────────────────────────
  for (const evicted of plan.evictions) {
    if (evicted.costRows.length > 0) {
      const salvage = salvageEvictedCellSpend(store, evicted);
      written.push(salvage.key);
      if (salvage.reused) knownDuplicateRows.push(...evicted.costRows);
    }
    store.remove([evicted.key], { allowCompleted: opts.allowCompleted === true });
    removed.push(evicted.key);
    log(`[prune] evicted ${evicted.key} (${evicted.state}${evicted.kind ? `/${evicted.kind}` : ""})`);
  }

  // ── 2. Compact attempt records ──────────────────────────────────────────
  for (const c of plan.compactions) {
    store.put({
      key: c.newKey,
      // Sentinel armId, exactly like the attempt recorders' own — this is a
      // side ledger record, not a planned cell. Invisible to planRun (whose
      // key regex requires a leading `arm=`) and visible to spendToDate
      // (which sums costRows across every stored body, unfiltered).
      armId: `__${c.family}-compacted__`,
      briefId: c.cellKey,
      replicate: 0,
      cfg: c.cfg,
      result: { kind: `${c.family}-compacted`, cellKey: c.cellKey, through: c.through },
      resolvedModels: { models: c.models },
      accounting: {
        state: "failed",
        kind: "harness_error",
        detail: `compacted ${c.family} records for cell '${c.cellKey}' through attempt ${c.through} (issue #98 retention)`,
      },
      costRows: c.rows,
    });
    written.push(c.newKey);
    store.remove(c.removeKeys);
    removed.push(...c.removeKeys);
    log(`[prune] compacted ${c.removeKeys.length} ${c.family} record(s) for '${c.cellKey}' into ${c.newKey} (${c.rowsBefore} -> ${c.rows.length} cost row(s))`);
  }

  // ── 3. Prove the money survived ─────────────────────────────────────────
  // The last line of defence, and the only one that runs in production: a
  // fold bug or a lost salvage shows up here, on the operator's terminal,
  // rather than three weeks later in a cost figure nobody can reconcile.
  const spendAfter = spendToDate(store);
  const duplicates = priceRows(knownDuplicateRows, DEFAULT_RATE_TABLE, { batch: true });
  const duplicatesByProvider = priceRowsByProvider(knownDuplicateRows, DEFAULT_RATE_TABLE, { batch: true });
  const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const providers = new Set([...Object.keys(spendBefore.byProvider), ...Object.keys(spendAfter.byProvider)]);
  const expectedTotal = spendBefore.totalUsd - duplicates.totalUsd;
  const drifted =
    !close(expectedTotal, spendAfter.totalUsd) ||
    [...providers].some((p) => !close((spendBefore.byProvider[p] || 0) - (duplicatesByProvider.byProvider[p] || 0), spendAfter.byProvider[p] || 0));
  if (drifted) {
    throw new Error(
      `pruneStore: spend-to-date changed across the prune -- $${spendBefore.totalUsd} before, $${spendAfter.totalUsd} after, ` +
        `$${expectedTotal} expected (${knownDuplicateRows.length} row(s) were a recognised crash-window duplicate, worth $${duplicates.totalUsd}). ` +
        `A prune must never make the study look cheaper (or dearer) than it was; this is a bug in the fold/salvage path, ` +
        `not an operator error. The store has already been modified -- restore it from a copy before running anything else.`,
    );
  }
  return { plan, spendBefore, spendAfter, removed, written, duplicateSpendUsd: duplicates.totalUsd };
}

/**
 * Re-home an evicted cell's cost rows under a `pruned-cell|cell=…|pruned=N`
 * record, so the money the cell paid for survives the cell.
 *
 * This is #90's own mechanism applied retroactively: a transient generation
 * failure written before #90 lives under `cell.key`, where it is permanently
 * `reuse`; after this it lives under an attempt-scoped key exactly as #90
 * would have written it, and the cell plans `todo` again.
 *
 * The `pruned=N` suffix is chosen so the operation is IDEMPOTENT rather than
 * merely unique: N is the lowest index at which either nothing is stored, or
 * what is stored is a salvage of THIS PHYSICAL cell record. So a prune
 * interrupted between the salvage write and the cell removal, then re-run,
 * reuses the record it already wrote instead of writing a second copy of the
 * same money.
 *
 * "This physical record" is the load-bearing phrase, and identity here is the
 * index entry's `storedAt`, never the body's content. Content cannot tell the
 * two cases apart, and they need opposite answers:
 *
 *   - CRASH: salvage written, process died before the cell was removed. The
 *     cell and the salvage hold the SAME money. A re-run must reuse.
 *   - RE-RUN: the cell was pruned, re-attempted, failed the same way, and
 *     was stored again — byte-identical content, but a SECOND real spend.
 *     A re-prune must write a second salvage.
 *
 * A `storedAt` collision would need two stores of the same cell key inside
 * one millisecond with a prune in between; the failure it would cause is an
 * under-count of one attempt, which is why the whole prune re-verifies
 * `spendToDate()` afterwards and throws rather than trusting this.
 */
function salvageEvictedCellSpend(store, evicted) {
  const body = {
    // A salvage record is not a measurement — it exists only to carry money.
    // It reports the failure kind the cell carried when the kind is a real
    // FAILURE_KINDS value, so "why is this cell todo again?" still has a
    // durable answer; a salvaged COMPLETED cell has no failure kind at all,
    // and `harness_error` is the honest stand-in (an operator deleted a
    // paid-for measurement, which is exactly the thing worth flagging).
    armId: `__${PRUNED_CELL_FAMILY}__`,
    briefId: evicted.key,
    replicate: 0,
    cfg: evicted.cfg,
    result: {
      kind: PRUNED_CELL_FAMILY,
      cellKey: evicted.key,
      prunedFromState: evicted.state,
      prunedFromKind: evicted.kind,
      // The identity of the cell record this salvages. See the doc above.
      prunedFromStoredAt: evicted.storedAt,
    },
    resolvedModels: evicted.resolvedModels,
    accounting: {
      state: "failed",
      kind: FAILURE_KINDS.includes(evicted.kind) ? evicted.kind : "harness_error",
      detail: `spend salvaged from pruned cell '${evicted.key}' (state=${evicted.state}, kind=${evicted.kind || "n/a"}); issue #98`,
    },
    costRows: evicted.costRows,
  };
  for (let n = 0; n < 1000; n++) {
    const key = `${PRUNED_CELL_FAMILY}|cell=${evicted.key}|pruned=${n}`;
    if (store.has(key)) {
      const prior = store.get(key);
      // Sorted-key comparison, not a bare JSON.stringify: what comes BACK
      // from the store was canonicalized on write (lib/store.mjs sorts
      // object keys), so a literal stringify of the record we are about to
      // write compares unequal to its own stored form purely on property
      // order. `result` carries `prunedFromStoredAt`, so this compares
      // RECORD IDENTITY and not merely equal content.
      if (canonicalJson(prior.result) === canonicalJson(body.result) && canonicalJson(prior.costRows) === canonicalJson(body.costRows)) {
        // Already salvaged by an interrupted earlier prune. The caller needs
        // to know, because removing the cell now takes away a DUPLICATE of
        // money that is already recorded, not money.
        return { key, reused: true };
      }
      continue;
    }
    store.put({ key, ...body });
    return { key, reused: false };
  }
  throw new Error(`salvageEvictedCellSpend: 1000 salvage records already exist for cell '${evicted.key}' -- refusing to write another`);
}

/** A candidate is either a bare string or an object carrying `.text` (same
 *  convention evals/judge/deidentify.mjs's deidentifyPool already uses). */
function candidateText(candidate) {
  if (typeof candidate === "string") return candidate;
  if (candidate && typeof candidate.text === "string") return candidate.text;
  throw new Error(`computeCellMetrics: candidate must be a string or an object with a .text field, got ${JSON.stringify(candidate)}`);
}

/**
 * Filter a spec's arms/briefs down to a requested subset (--arms/--briefs),
 * throwing on a name that doesn't exist rather than silently running fewer
 * cells than the caller thinks they asked for.
 */
function subsetSpec(spec, { arms, briefs, replicates } = {}) {
  let out = spec;
  if (arms && arms.length) {
    const wanted = new Set(arms);
    const filtered = spec.arms.filter((a) => wanted.has(a.id));
    const missing = arms.filter((id) => !spec.arms.some((a) => a.id === id));
    if (missing.length) throw new Error(`runSpec: --arms references unknown arm(s): ${missing.join(", ")}`);
    out = { ...out, arms: filtered };
  }
  if (briefs && briefs.length) {
    const wanted = new Set(briefs);
    const filtered = spec.briefs.filter((b) => wanted.has(b.id));
    const missing = briefs.filter((id) => !spec.briefs.some((b) => b.id === id));
    if (missing.length) throw new Error(`runSpec: --briefs references unknown brief(s): ${missing.join(", ")}`);
    out = { ...out, briefs: filtered };
  }
  if (replicates !== undefined) {
    out = { ...out, replicates };
  }
  return out;
}

/**
 * Reconstruct cumulative spend-to-date from the store's own cost rows --
 * the DURABLE record -- rather than from any in-memory counter, which is
 * exactly what dies with the process and is the bug issue #64 exists to fix
 * ("a resumed run restarts its budget at zero"). Walks every stored cell's
 * `costRows` and prices them at READ time via `lib/price.mjs` (`priceRows`/
 * `priceRowsByProvider`) -- never a stored dollar figure; `store.put()`
 * already refuses one (cron-fleet#75), and this function is the reader that
 * honors that contract on the way back out.
 *
 * ── Scope: the WHOLE store, across every configHash (the AC's required,
 * stated decision) ─────────────────────────────────────────────────────
 * A configHash bump (harness version, prompt edit, ...) marks a cell as NOT
 * COMPARABLE for analysis (lib/manifest.mjs's `stale` path) -- but it does
 * not refund money already spent under the old config. The operator's
 * ceiling is a cap on the study's real dollars, not a cap scoped to one
 * config generation. Scoping this function to "only the current configHash"
 * would let a harness bump silently reset the budget -- reproducing this
 * exact issue's defect (spend resets on re-invocation) under a different
 * trigger (spend resets on config change) instead of closing it. So this
 * sums cost rows across the ENTIRE store, regardless of each record's `cfg`.
 *
 * ── What this measures, given issue #68 ─────────────────────────────────
 * This sums whatever cost rows the store actually holds -- nothing more,
 * nothing less. UPDATED (PR #76 fix round): issue #68 now wires
 * `runJudgeMatrix` into `runSpec()`'s own per-cell loop (see
 * `judgePoolIfEnabled` below), so judge cost rows DO land via `store.put()`
 * on this path -- this function picks them up with zero changes of its own,
 * because it prices the ledger, never a projection, exactly as designed.
 * `runJudgeValidation` is a separate composition (evals/judge/validate.mjs)
 * that still has no non-test caller -- out of scope for #68 (filed
 * separately) -- so its cost rows are absent from any store `runSpec()`
 * alone populates; that is a scoping gap in a DIFFERENT code path, not a
 * defect in what this function measures.
 *
 * The resume blind spot this comment used to describe is CLOSED as of #68:
 * `judgePoolIfEnabled` judges a `plan.reuse` cell (already generated in an
 * earlier session, not yet judged) on THIS invocation too, not only
 * `plan.todo` cells -- see the per-cell loop and the `plan.reuse` restore
 * loop below. `runnerPriceGrid`'s pre-flight PROJECTION still only estimates
 * judging for `plan.todo` (it has no way to know a reused cell needs
 * judging until the ACTUAL run discovers that), so a reused-but-unjudged
 * cell's judge spend is unprojected but IS metered and counted here once it
 * runs -- a pre-flight under-estimate, never a ledger under-count.
 *
 * @param {object} store       a lib/store.mjs ResultsStore
 * @param {object} [rateTable=DEFAULT_RATE_TABLE]  pinned, dated rate table
 * @param {{batch?: boolean}} [opts]  batch discount to apply when re-pricing
 *   (matches the `batch` flag `runSpec()`/`runnerPriceGrid` price the plan
 *   under -- this study is batch-first by default, see the module header)
 * @returns {{ totalUsd: number, byProvider: Object<string, number>,
 *   hasMissingRate: boolean, missingRateModels: string[],
 *   excludedNonProviderUsd: number, excludedNonProviderModels: string[] }}
 *   `totalUsd` includes excluded non-provider spend (e.g. the embedder);
 *   `byProvider` never does -- see the excludedNonProviderUsd/Models fields
 *   for that money, tracked separately rather than silently dropped.
 */
export function spendToDate(store, rateTable = DEFAULT_RATE_TABLE, { batch = true } = {}) {
  if (!store) throw new Error("spendToDate: store is required");
  // COST NOTE (PR #72 review): this reads and JSON-parses EVERY stored
  // body -- store.get() is the only method that touches bodies/ (see
  // lib/store.mjs's own header), and index.jsonl carries no per-cell cost
  // rows of its own, so there is no cheaper path to "every cost row in the
  // store" than this. On a large grid (hundreds of cells, each body
  // potentially carrying a full provider reply) this is real work -- see
  // runSpec()'s own comment at the call site for why it is now paid ONLY
  // when a ceiling is actually requested, never on every invocation.
  const allCostRows = [];
  for (const entry of store.list()) {
    let body;
    try {
      body = store.get(entry.key);
    } catch (err) {
      // A truncated/missing body (readFileSync/JSON.parse have no tolerance
      // -- see lib/store.mjs) must not surface as a bare SyntaxError/ENOENT
      // three stack frames from here. Name the offending key so whoever
      // hits this has something to act on -- inspect or repair
      // <store.dir>/bodies/, or accept the loss and manually strip the
      // index.jsonl line for this key if the body is genuinely gone.
      throw new Error(
        `spendToDate: could not read the stored body for key '${entry.key}' (bodyFile '${entry.bodyFile}') -- ` +
          `a spend ceiling cannot be enforced against a ledger entry it cannot read. Original error: ${err && err.message}. ` +
          `Inspect '${store.bodiesDir}' for a truncated or missing file, or repair/remove the corresponding line in '${store.indexPath}' if the record is unrecoverable.`,
      );
    }
    if (Array.isArray(body.costRows)) allCostRows.push(...body.costRows);
  }
  const totals = priceRows(allCostRows, rateTable, { batch });
  const byProviderTotals = priceRowsByProvider(allCostRows, rateTable, { batch });
  return {
    totalUsd: totals.totalUsd,
    byProvider: byProviderTotals.byProvider,
    hasMissingRate: totals.hasMissingRate || byProviderTotals.hasMissingRate,
    missingRateModels: [...new Set([...totals.missingRateModels, ...byProviderTotals.missingRateModels])],
    // excludedNonProviderUsd/Models (issue #64 follow-up, cwc PR #72 review):
    // KNOWN non-provider spend (currently just the embedder, `voyage-*` --
    // Phase 0/#69 writes real `voyage-4-lite` cost rows to this SAME store)
    // -- priced and counted in `totalUsd` above (priceRows() prices every
    // row regardless of provider), but deliberately excluded from
    // `byProvider`, so a per-provider ceiling is never gated by spend that
    // isn't Anthropic or OpenAI spend, and `lib/price.mjs`'s `providerOf`
    // is never asked to classify a model it correctly has no provider
    // bucket for. Surfaced here -- not silently dropped -- so a caller can
    // see embedder spend is tracked, just outside the provider ceilings.
    excludedNonProviderUsd: byProviderTotals.excludedNonProviderUsd,
    excludedNonProviderModels: byProviderTotals.excludedNonProviderModels,
  };
}

/**
 * Plan a spec against the store (the shared first half of dry-run and a real
 * run) and price the `todo` set. Pulled out of runSpec() so --dry-run and the
 * real run price identically -- no drift between "what dry-run predicted" and
 * "what a real run would refuse to start over".
 *
 * @returns {{ plan: {todo, reuse, stale}, projection: {usd, breakdown} }}
 */
export function planAndPrice(spec, { store, armsConfig, priceGrid = interimPriceGrid, batch = true } = {}) {
  if (!store) throw new Error("planAndPrice: store is required (feeds planRun's resume/reuse diff)");
  if (!armsConfig || !armsConfig.arms) throw new Error("planAndPrice: armsConfig (arms.config.json shape, with an .arms map) is required");

  const plan = planRun(spec, store.keys());
  const projection = priceGrid(plan.todo, armsConfig.arms, { batch });
  return { plan, projection };
}

/**
 * The runner. Turns a spec into completed, reconciled cells.
 *
 * @param {object} spec              { arms: [{id}], briefs: [{id}], replicates, config }
 *   `spec.arms` here is the FULL arm list with `.id` (as lib/manifest.mjs
 *   expects); resolved model config for each arm comes from `armsConfig`.
 * @param {object} opts
 *   @param {object} opts.store        a lib/store.mjs ResultsStore instance
 *   @param {object} opts.armsConfig   parsed arms.config.json ({ arms: {...} })
 *   @param {object} opts.provider     { generate(cell, arm, {mode, timestamp}) }
 *   @param {Function} [opts.priceGrid]  injected pricer; defaults to interimPriceGrid
 *   @param {boolean} [opts.batch]       batch-first: defaults to true. This
 *     default is the whole point of "batch-first" -- non-batch is opt-out via
 *     `batch: false`, never opt-in.
 *   @param {boolean} [opts.dryRun]      if true: prints the plan and returns
 *     WITHOUT touching the store or the provider. No side effects at all.
 *   @param {number}  [opts.maxSpendUsd] pre-flight ceiling; if CUMULATIVE
 *     spend-to-date (issue #64, reconstructed from the store's own cost rows
 *     across every prior invocation and every configHash -- see
 *     `spendToDate`) plus the priced projection exceeds it, the run refuses
 *     to start (see below for the precise semantics -- this is a per-cell
 *     admission control, not just an abort switch, so a run can still make
 *     partial progress under a cap). A resumed run's ceiling therefore gates
 *     the STUDY's total spend, not just this invocation's -- re-invoking the
 *     runner N times no longer permits N x the stated cap.
 *   @param {Object<string,number>} [opts.maxSpendByProviderUsd] per-provider
 *     ceilings (issue #51), e.g. `{ anthropic: 300, openai: 150 }` -- keyed by
 *     `lib/price.mjs`'s `providerOf()` output. Same fail-closed, per-cell,
 *     CUMULATIVE admission-control semantics as `maxSpendUsd`, evaluated
 *     independently PER PROVIDER: a cell is skipped once THAT cell's
 *     provider(s) would push their own cumulative total (spend-to-date +
 *     this invocation's real spend so far + this cell's projected share)
 *     over THEIR ceiling, even if other providers (or the global
 *     `maxSpendUsd`) still have headroom. A cross-provider cell (arm G) is
 *     checked against every provider it actually spends under, not just
 *     one. The skip detail names the specific provider that tripped
 *     (`budget_exceeded:<provider>`), distinct from the unqualified
 *     `"budget_exceeded"` the global ceiling records.
 *   @param {object} [opts.rateTable] the pinned, dated rate table used to
 *     derive ACTUAL per-provider spend from each completed/failed cell's real
 *     `tokens_by_model` (never a flat per-cell/per-run assignment -- see the
 *     per-cell loop). Defaults to `lib/price.mjs`'s `RATE_TABLE`; only ever
 *     overridden by a test.
 *   @param {string[]} [opts.armIds]     --arms subset
 *   @param {string[]} [opts.briefIds]   --briefs subset
 *   @param {number}   [opts.replicates] --replicates override
 *   @param {(msg: string) => void} [opts.log]  defaults to console.log; tests
 *     inject a silent logger to keep test output clean.
 *   @param {{anthropic?: string[], openai?: string[]}} [opts.judgeModels]
 *     candidate judge models per provider (evals/judge/matrix.mjs's
 *     buildJudgeMatrix shape). THE SWITCH THAT ENABLES JUDGING (issue #68):
 *     when omitted, runSpec() behaves exactly as before -- generation only,
 *     no judge account, `summary.judge` is `null`. A real CLI invocation
 *     (evals/run.mjs) always supplies this, so a genuine run always judges;
 *     tests that only care about generation stay unaffected by omitting it.
 *   @param {{anthropic?: object, openai?: object}} [opts.judgeProviders] a
 *     JudgeProvider (`.score()`) per provider, same shape runJudgeMatrix
 *     takes. A leg with no wired provider is recorded as a deferred SKIP
 *     (`judge_deferred:<provider>:...`), never dropped -- see the per-pool
 *     judging helper below. Only meaningful when `judgeModels` is set.
 *   @param {Array<{id:string, text:string}>} [opts.corpus] the study's
 *     briefs, so a pool's judge call can look up its brief text by
 *     `cell.briefId`. Required whenever `judgeModels` is set.
 *   @param {number} [opts.judgeSeed=1] base integer seed forwarded to
 *     runJudgeMatrix per pool (it derives a distinct, replayable per-leg seed
 *     from this base + the pool key -- see score.mjs).
 *   @param {{embed: (texts: string[]) => Promise<number[][]>, modelId: string,
 *     usage?: {total_tokens: number}}} [opts.embedder] THE SWITCH THAT ENABLES
 *     POOL METRICS (issue #85): when omitted, runSpec() behaves exactly as
 *     before -- no distinct_k/pool/diversity/collapseRate ever computed or
 *     stored. A real CLI invocation (evals/run.mjs) always supplies this
 *     (evals/metrics/embedder.mjs's voyageEmbedder), so a genuine run always
 *     measures pool metrics. `usage.total_tokens`, when present, is read as a
 *     CUMULATIVE counter (voyageEmbedder's own contract) -- this function
 *     meters the DELTA across one embed() call, never the running total, so
 *     an embedder shared across many cells in one invocation is never
 *     double-metered.
 *   @param {number} [opts.clusterDistanceThreshold] the calibrated clustering
 *     distance threshold for whichever embedding space `opts.embedder`
 *     produces (VOYAGE_CLUSTER_DISTANCE_THRESHOLD for the live embedder,
 *     CLUSTER_DISTANCE_THRESHOLD for the hermetic MiniLM fixture embedder --
 *     see evals/metrics/clustering.mjs's header for why the two spaces need
 *     different thresholds). Required whenever `opts.embedder` is set.
 * @returns {Promise<{summary: object, dryRun?: object}>}
 */
export async function runSpec(spec, opts) {
  const {
    store,
    armsConfig,
    provider,
    priceGrid = interimPriceGrid,
    batch = true, // batch-first: the DEFAULT is true, not a flag callers must set
    dryRun = false,
    maxSpendUsd,
    maxSpendByProviderUsd,
    rateTable = DEFAULT_RATE_TABLE,
    armIds,
    briefIds,
    replicates,
    log = (msg) => console.log(msg),
    judgeModels,
    judgeProviders,
    corpus,
    judgeSeed = 1,
    embedder,
    clusterDistanceThreshold,
  } = opts || {};

  if (!store) throw new Error("runSpec: store is required");
  if (!armsConfig || !armsConfig.arms) throw new Error("runSpec: armsConfig is required");
  if (!dryRun && !provider) throw new Error("runSpec: provider is required unless dryRun is true");
  // Judging is opt-in via judgeModels (see the opts doc above), but once
  // opted in it needs the brief text every pool judges against -- fail loud
  // at the top of the function rather than discovering the gap mid-run after
  // real generation spend has already happened.
  const judgingEnabled = !!judgeModels;
  if (judgingEnabled && !Array.isArray(corpus)) {
    throw new Error("runSpec: judgeModels was supplied but opts.corpus (array of { id, text } briefs) was not -- judging needs each pool's brief text");
  }
  // Pool metrics (issue #85) are opt-in via opts.embedder, exactly like
  // judging's opts.judgeModels switch above: omitted, runSpec() behaves
  // exactly as before (generation only, no distinct_k/pool ever computed).
  // A real CLI invocation (evals/run.mjs) always supplies both opts.embedder
  // and opts.clusterDistanceThreshold, so a genuine run always measures
  // pool metrics -- the same "always wired for a real invocation" shape
  // issue #68/#76 established for judging. Checked up front, before any
  // provider spend happens, so a misconfigured metrics pass fails at the
  // moment you'd expect rather than after burning generation money on the
  // first cell.
  const metricsEnabled = !!embedder;
  if (metricsEnabled && !Number.isFinite(clusterDistanceThreshold)) {
    throw new Error(
      "runSpec: opts.embedder was supplied but opts.clusterDistanceThreshold is missing/invalid -- pool metrics " +
        "need the calibrated clustering distance threshold for whichever embedding space opts.embedder produces " +
        "(evals/metrics/voyage-calibration.mjs's VOYAGE_CLUSTER_DISTANCE_THRESHOLD for the live Voyage embedder, " +
        "or evals/metrics/calibration.mjs's CLUSTER_DISTANCE_THRESHOLD for the hermetic MiniLM fixture embedder).",
    );
  }

  const effectiveSpec = subsetSpec(spec, { arms: armIds, briefs: briefIds, replicates });
  const { plan, projection } = planAndPrice(effectiveSpec, { store, armsConfig, priceGrid, batch });

  // ── --dry-run: print the plan, spend NOTHING. Calls nothing at all --
  // no provider, no store writes. This branch returns before either is ever
  // touched, which is what the AC's "no store writes, no provider calls"
  // requirement demands (a spy on the provider stays empty; the store's
  // keys() before/after this call are identical because we never call put()).
  if (dryRun) {
    log(`[dry-run] plan: ${plan.todo.length} todo, ${plan.reuse.length} reuse, ${plan.stale.length} stale`);
    log(`[dry-run] projected cost: $${projection.usd.toFixed(4)} (batch=${batch})`);
    if (plan.stale.length) {
      log(`[dry-run] WARNING: ${plan.stale.length} stored cell(s) are stale under this config and were NOT reused`);
    }
    return { dryRun: { plan, projection } };
  }

  // ── Cumulative spend-to-date (issue #64): reconstructed from the store's
  // own cost rows -- the durable record -- BEFORE any admission decision is
  // made, so a ceiling is enforced against "everything this study has ever
  // actually spent", not against an in-memory counter that resets to zero
  // every time this function is called. See `spendToDate`'s own header for
  // the full rationale, including why it sums across every configHash and
  // what it does and does not measure given issues #68 and the resume
  // judging blind spot.
  //
  // Computed ONLY when a ceiling is actually active (PR #72 review, MEDIUM):
  // `spendToDate` reads and JSON-parses EVERY stored body (see that
  // function's own cost note) -- on a real grid that is real work, and
  // `store.get()` has no tolerance for a truncated/missing body file
  // (readFileSync + JSON.parse, no try/catch of its own -- see
  // lib/store.mjs). Computing this unconditionally would make EVERY
  // invocation -- including one with no --max-spend/--max-spend-<provider>
  // at all -- pay that cost and inherit that fragility for a number nothing
  // is gating against. A run with no ceiling has nothing to enforce
  // cumulative spend against, so it neither reads the full store history
  // nor can be broken by damage to a body a plain generation run would
  // never otherwise touch. The tradeoff: `summary.cumulativeSpendByProvider`/
  // `cumulativeSpendUsd`/`cumulativeNonProviderSpendUsd`/
  // `cumulativeNonProviderModels` below are `null` -- NOT `{}`/`0`, which
  // would read as "checked, and it's zero" -- whenever no ceiling was
  // requested this invocation. Call `spendToDate(store)` directly to get
  // those figures on demand outside a ceiling-gated run.
  const anyCeilingActive = maxSpendUsd !== undefined || !!maxSpendByProviderUsd;
  const priorSpend = anyCeilingActive ? spendToDate(store, rateTable, { batch }) : null;
  if (priorSpend && priorSpend.hasMissingRate) {
    throw new Error(
      `runSpec: cumulative spend-to-date cannot be priced -- the store already holds cost row(s) for model(s) with no RATE_TABLE entry ` +
        `(${priorSpend.missingRateModels.join(", ")}) -- a spend ceiling cannot be enforced against a ledger it cannot fully price. ` +
        `Add the missing model(s) to lib/price.mjs's RATE_TABLE.`,
    );
  }

  // ── --max-spend: pre-flight prices the planned grid and REFUSES TO START
  // if spend-to-date PLUS the projection exceeds the ceiling. "Refuses to
  // start" here means: no cell in the over-budget run is ever sent to the
  // provider. We still want every planned cell accounted for (the
  // non-negotiable), so cells are walked in order and skipped via RunAccount
  // as soon as the running total (spend-to-date + this session's real spend
  // so far) would exceed the cap -- rather than aborting the process
  // outright, which would leave earlier todo cells un-accounted. If
  // spend-to-date alone already meets or exceeds the ceiling, the whole
  // grid is skipped immediately (see the per-cell loop, which folds
  // `priorSpend.totalUsd` into every comparison).
  const overBudget = maxSpendUsd !== undefined && priorSpend.totalUsd + projection.usd > maxSpendUsd;
  if (maxSpendUsd !== undefined) {
    log(
      `[max-spend] ceiling=$${maxSpendUsd} spent-to-date=$${priorSpend.totalUsd.toFixed(4)} projected=$${projection.usd.toFixed(4)} ` +
        `${overBudget ? "(over budget -- admission-controlling cells)" : "(within budget)"}`,
    );
  }

  // ── --max-spend-<provider>: the SAME fail-closed pre-flight, priced PER
  // PROVIDER from the pinned dated rate table (issue #51 -- a single global
  // ceiling cannot express "substantial Anthropic headroom, a firm preference
  // against comparable OpenAI spend"). Requires every priced todo cell to
  // carry a `byProvider` breakdown (both interimPriceGrid and
  // lib/price.mjs's runnerPriceGrid do, built slot-by-slot so a cross-provider
  // cell like arm G is split proportionally, never flat-assigned to one
  // provider) -- fail loud if an injected priceGrid omits it, the same
  // "missing from the breakdown" precedent the per-cell loop already applies
  // to `usd` below.
  if (maxSpendByProviderUsd) {
    const projectedByProvider = {};
    for (const entry of projection.breakdown) {
      if (!entry.byProvider) {
        throw new Error(
          `runSpec: --max-spend-<provider> requires every priced todo cell to carry a 'byProvider' breakdown, but '${entry.cellKey}' has none -- ` +
            `the injected priceGrid must report per-provider cost (see lib/price.mjs's runnerPriceGrid / interimPriceGrid)`,
        );
      }
      for (const [provider, usd] of Object.entries(entry.byProvider)) {
        projectedByProvider[provider] = (projectedByProvider[provider] || 0) + usd;
      }
    }
    for (const [provider, ceiling] of Object.entries(maxSpendByProviderUsd)) {
      const spentToDate = priorSpend.byProvider[provider] || 0;
      const projected = projectedByProvider[provider] || 0;
      const providerOverBudget = spentToDate + projected > ceiling;
      log(
        `[max-spend-${provider}] ceiling=$${ceiling} spent-to-date=$${spentToDate.toFixed(4)} projected=$${projected.toFixed(4)} ` +
          `${providerOverBudget ? `(over budget -- refusing to start ${provider} cells beyond the ceiling)` : "(within budget)"}`,
      );
    }
  }

  const plannedKeys = [...plan.reuse.map((c) => c.key), ...plan.todo.map((c) => c.key)];
  const account = new RunAccount(plannedKeys);

  // runningTotal / runningTotalByProvider: ACTUAL spend from cells that
  // complete/fail DURING THIS INVOCATION, tracked between cells as they
  // finish (issue #51 -- "not only in the pre-flight") -- seeded at 0 and
  // updated below from each completed/failed cell's REAL `tokens_by_model`,
  // never from the pre-run projection. These deliberately stay
  // THIS-INVOCATION-ONLY (see `summary.spendByProvider` at the bottom of
  // this function, whose meaning existing callers depend on); every
  // admission decision below adds `priorSpend`/`priorSpend.byProvider` -- the
  // cumulative total reconstructed from the store BEFORE this invocation
  // started (issue #64) -- on top of these, so the CEILING is enforced
  // cumulatively even though these two counters are not.
  //
  // Declared HERE (before the reuse loop and the judging block below), not
  // next to `priceByKey`/`providerByKey` further down: issue #68's judging
  // pass can run from WITHIN the reuse loop (a generated-but-unjudged pool
  // from a prior session, see judgePoolIfEnabled below), and it routes judge
  // cost rows through `recordActualSpend` -- which closes over these. A
  // `const`/`let` referenced before its own declaration line has executed is
  // a ReferenceError (TDZ) regardless of function-declaration hoisting, so
  // these must exist before the FIRST possible call, not merely before the
  // todo loop that historically was the only caller.
  let runningTotal = 0;
  const runningTotalByProvider = {};
  // runningNonProviderTotal: ACTUAL this-invocation spend on a KNOWN
  // non-provider model (issue #64 follow-up -- currently only reachable if a
  // future cell's response ever carries embedder tokens through THIS loop,
  // which is not how Phase 0/#69 records embedder spend today; kept for
  // symmetry with runningTotalByProvider and so this total is never silently
  // dropped if that ever changes). Mirrors `priceRowByProvider`'s
  // `excludedNonProviderUsd` -- never folded into `runningTotalByProvider`,
  // never thrown on.
  let runningNonProviderTotal = 0;

  // Fold one cell's cost rows (real `tokens_by_model`, priced at read time
  // from `rateTable`) into `runningTotalByProvider`, grouped by provider --
  // NEVER a flat per-cell/per-run assignment. This is what makes arm G's
  // actual spend land correctly split across Anthropic and OpenAI instead of
  // wholly on whichever model happens to be listed first in the row.
  //
  // Fail loud on a missing rate WHEN ANY spend ceiling is active -- global
  // OR per-provider (issue #62 MEDIUM, widened by issue #78): runnerPriceGrid's
  // fail-loud-on-missing-rate guard (extended to judge legs too as of issue
  // #63) only ever runs at PLAN time, against the PROJECTED grid -- it never
  // sees a judge row's ACTUAL tokens_by_model. A judge call now DOES reach
  // this function (issue #68 wires runJudgeMatrix's costRows through the SAME
  // recordActualSpend every generation cell uses -- see judgePoolIfEnabled
  // below), so this guard is exactly what makes a rate-less judge model fail
  // loud instead of silently contributing $0 to `runningTotal` /
  // `runningTotalByProvider` (priceRowByProvider's documented, otherwise-
  // correct default for re-pricing a recorded row), quietly undercounting
  // real spend against the very ceiling this admission control exists to
  // enforce. Issue #78: this guard used to check `maxSpendByProviderUsd`
  // alone, so a run with ONLY a global `--max-spend` (no per-provider
  // ceiling) primed a rate-less model at $0 into `runningTotal`, which the
  // per-cell loop below DOES compare against `maxSpendUsd` -- the guard's
  // coverage did not follow the pricing it was protecting. Gated on
  // `anyCeilingActive` (same flag that decides whether `priorSpend` is even
  // computed, above) so it fires whenever EITHER ceiling depends on
  // per-row pricing. A run with NO ceiling at all has nothing to gate, and
  // priceRowByProvider's $0-and-continue default remains correct for it.
  function recordActualSpend(costRows) {
    for (const row of costRows) {
      const { byProvider, hasMissingRate, missingRateModels, excludedNonProviderUsd } = priceRowByProvider(row, rateTable, { batch });
      if (anyCeilingActive && hasMissingRate) {
        throw new Error(
          `runSpec: cell '${row.cellKey || row.key}' recorded actual spend for model(s) with no RATE_TABLE entry ` +
            `(${missingRateModels.join(", ")}) -- a spend ceiling cannot gate spend it cannot price. ` +
            `Add the missing model(s) to lib/price.mjs's RATE_TABLE.`,
        );
      }
      let rowTotalUsd = excludedNonProviderUsd;
      for (const [provider, usd] of Object.entries(byProvider)) {
        runningTotalByProvider[provider] = (runningTotalByProvider[provider] || 0) + usd;
        rowTotalUsd += usd;
      }
      // A known non-provider model (e.g. the embedder) in a generation/judge
      // cell's cost rows is NOT gated by any provider ceiling -- tracked here
      // rather than silently dropped, never thrown on. See isNonProviderModel
      // (lib/price.mjs) and spendToDate's own excludedNonProviderUsd.
      runningNonProviderTotal += excludedNonProviderUsd;
      // Sentry review finding (PR #76 fix round, HIGH): `runningTotal` --
      // the GLOBAL `--max-spend` ceiling's actual-spend-so-far counter --
      // was never updated here, only `runningTotalByProvider` was. Judge
      // spend (and, in principle, any actual spend at all) therefore never
      // reached the global ceiling's admission check, which used a STALE
      // per-cell PROJECTED increment instead (see the removed
      // `runningTotal += cellCost` at the old call site below -- replaced
      // by this actual-spend accumulation, mirroring `runningTotalByProvider`
      // exactly). Basis matches `priorSpend.totalUsd` (see the summary-
      // assembly BASIS comment near the end of this function): ALL priced
      // spend, provider AND non-provider, since a global ceiling is a
      // total-dollars backstop, not scoped to any one provider.
      runningTotal += rowTotalUsd;
    }
  }

  // ── Judging (issue #68) ──────────────────────────────────────────────────
  // A SEPARATE RunAccount for judge legs, deliberately not folded into
  // `account` above: `account`'s planned set is fixed at construction from
  // the generation plan (todo+reuse) and existing tests/callers read
  // `summary.planned/completed/failed/skipped` as GENERATION-cell counts
  // (e.g. runner.test.mjs's "issue #62 BLOCKER 2" and every `summary.planned
  // === N` assertion across the suite). Judge legs aren't known until a
  // cell's generation result exists (a leg's identity depends on
  // buildJudgeMatrix's arm-based judge selection), so they're planned
  // INCREMENTALLY into `judgeAccount.planned` as each pool is judged, below.
  // `judgeAccount.reconcile()` is called at the very end alongside
  // `account.reconcile()` -- if ANY judge leg never reaches a terminal state,
  // THAT throws too, so the run as a whole still fails on an unjudged pool
  // (AC5: "reconcile() treats an unjudged pool as a non-terminal cell rather
  // than silently passing it") without redefining what `account`'s own
  // summary counts have always meant.
  const judgeAccount = judgingEnabled ? new RunAccount([]) : null;
  const resolvedJudgeProviders = judgeProviders || {};
  const briefTextByBriefId = judgingEnabled ? new Map(corpus.map((b) => [b.id, b.text])) : null;
  // Snapshot of what the store already holds BEFORE this invocation judges
  // anything -- store.keys() is index-only (cheap; see lib/store.mjs), unlike
  // spendToDate's whole-body read. Used ONLY to detect "this leg was already
  // scored in a prior session" (issue #68 AC4, the resume blind spot) so a
  // resumed run never re-calls a leg meterJudgeCall already wrote -- a
  // second store.put() under the same judge-call key with a fresh timestamp
  // would throw (lib/store.mjs's byte-identical-or-throw contract). A leg
  // this SAME invocation just scored is never re-checked against this stale
  // snapshot because each pool is judged exactly once per run.
  const existingStoreKeysForJudging = judgingEnabled ? new Set(store.keys()) : null;

  /** Reserved, namespaced RunAccount key for one pool's one judge leg --
   *  in-memory bookkeeping only (never a store key; compare judgeScoresKey/
   *  meterJudgeCall's own store-key namespaces in evals/judge/score.mjs and
   *  gate.mjs, which this deliberately does not collide with). */
  function judgeLegKey(poolKey, judgeProvider) {
    return `judge|pool=${poolKey}|provider=${judgeProvider}`;
  }

  /**
   * Compute pool-level metrics (issue #85) for one completed generation
   * cell's candidates -- distinct_k, the embedded pool itself, diversity,
   * collapse rate, and the LiveIdeaBench fluency/flexibility bundle -- from
   * exactly ONE clustering call, per clustering.mjs/diversity.mjs's own
   * "never recomputed independently" discipline. No-op (returns null) when
   * metrics are disabled (opts.embedder was never supplied).
   *
   * ── Never throws -- classifies instead (mirrors judge/score.mjs's
   * providers) ──────────────────────────────────────────────────────────
   * The embedder is a real network call (evals/metrics/embedder.mjs's
   * voyageEmbedder) and CAN fail (missing credential, transient transport
   * failure exhausted its own retry budget, a malformed response). Letting
   * that exception propagate here would land BETWEEN this cell's already-
   * spent generation money and the single store.put() that is the only
   * place that money can be durably recorded (lib/store.mjs is append-only
   * -- there is no second write to add metrics to an already-stored cell).
   * So this function catches everything and returns a classified outcome;
   * the caller (the per-cell loop below) decides what to do with it. This
   * is the SAME "provider never throws, caller classifies" shape
   * evals/judge/score.mjs's AnthropicJudgeProvider/OpenAIJudgeProvider
   * already use, applied to the embedder instead of a judge model.
   *
   * ── Metering the embedder's DELTA, not its running total ────────────────
   * `embedder.usage.total_tokens` (voyageEmbedder's own contract) is
   * CUMULATIVE across every embed() call made on that one embedder
   * instance -- and one embedder instance is shared across every cell in a
   * single runSpec() invocation. Snapshotting before/after and metering
   * only the delta is what keeps a later cell from being charged for an
   * earlier cell's tokens too. Read in a `finally` block so a partially
   * successful embed() call (some chunks succeeded before a later chunk
   * threw -- see embedder.mjs's per-chunk usage accounting) still meters
   * the tokens it actually consumed, mirroring runJudgeMatrix's own "tokens
   * consumed by a failed call are still spend" rule.
   *
   * @param {{key: string}} cell
   * @param {Array} candidates  the completed cell's result.candidates
   * @param {string} timestamp  ISO 8601, caller-supplied (costRow requires it)
   * @returns {Promise<{ok: true, resultPatch: object, costRows: Array} | {ok: false, detail: string, costRows: Array}>}
   */
  async function computeCellMetrics(cell, candidates, timestamp) {
    let beforeTokens = (embedder.usage && embedder.usage.total_tokens) || 0;
    let costRows = [];
    try {
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error("completed result has no candidates to embed");
      }
      const texts = candidates.map(candidateText);
      const vectors = await embedder.embed(texts);
      const { k: distinctK } = clusterByThreshold(vectors, clusterDistanceThreshold);
      const rawCandidateCount = candidates.length;
      const resultPatch = {
        distinct_k: distinctK,
        pool: vectors,
        // Post-dedup pool size (Appendix C item 5) IS distinct_k -- one
        // survivor per occupied semantic equivalence class (see
        // diversity.mjs collapseRate's own header). Named explicitly,
        // alongside the raw pre-dedup count already recoverable as
        // candidates.length, so both halves of Appendix C's per-arm pool
        // accounting are self-describing on the stored record.
        postDedupPoolSize: distinctK,
        rawCandidateCount,
        // poolDiversity needs >= 2 embedded items (diversity.mjs); a
        // singleton pool has no pairwise distance to average, which is a
        // real, legitimate state (not an error) -- reported as `null`
        // ("not computable"), never a fabricated 0.
        poolDiversity: vectors.length >= 2 ? poolDiversity(vectors) : null,
        collapseRate: collapseRate(distinctK, rawCandidateCount),
        ...poolMetricsSummary({ pool: candidates, distinctKCount: distinctK }),
      };
      return { ok: true, resultPatch, costRows };
    } catch (err) {
      return { ok: false, detail: `pool metrics failed for cell '${cell.key}': ${err && err.message}`, costRows };
    } finally {
      const afterTokens = (embedder.usage && embedder.usage.total_tokens) || 0;
      const delta = afterTokens - beforeTokens;
      if (delta > 0) {
        costRows.push(costRow({ cellKey: cell.key, timestamp, billing_mode: "api", model: embedder.modelId, input_tokens: delta }));
      }
    }
  }

  /**
   * Judge one completed generation cell as a pool (poolKey === cell.key --
   * see evals/judge/matrix.mjs's header). No-op when judging is disabled.
   * Idempotent across sessions: a leg the store already holds a judge-scores
   * record for is acknowledged as already-terminal, never re-called.
   */
  async function judgePoolIfEnabled(cell, arm, result) {
    if (!judgingEnabled) return;
    if (!arm) throw new Error(`runSpec: judging cell '${cell.key}' -- unknown arm '${cell.armId}'`);
    const briefText = briefTextByBriefId.get(cell.briefId);
    if (!briefText) {
      throw new Error(`runSpec: judging cell '${cell.key}' -- no corpus brief found for briefId '${cell.briefId}'`);
    }
    const candidates = result && result.candidates;
    if (!Array.isArray(candidates)) {
      throw new Error(`runSpec: judging cell '${cell.key}' -- completed result has no .candidates array to judge`);
    }
    const armWithId = { id: cell.armId, ...arm };
    // buildJudgeMatrix is deterministic given (poolKey, arm, judgeModels) --
    // calling it here (before deciding what to run) and again inside
    // runJudgeMatrix below is cheap and lets this function know each leg's
    // resolved judge_model up front, which is what the store-key resume
    // check needs (judgeScoresKey is keyed by MODEL, not provider).
    const rows = buildJudgeMatrix([{ poolKey: cell.key, arm: armWithId }], { judgeModels });
    for (const row of rows) judgeAccount.planned.add(judgeLegKey(row.poolKey, row.judge_provider));

    const providersToCall = {};
    const alreadyJudged = new Set();
    for (const row of rows) {
      const scoresKey = judgeScoresKey({ poolKey: row.poolKey, judgeModel: row.judge_model });
      if (existingStoreKeysForJudging.has(scoresKey)) {
        alreadyJudged.add(row.judge_provider);
      } else if (resolvedJudgeProviders[row.judge_provider]) {
        providersToCall[row.judge_provider] = resolvedJudgeProviders[row.judge_provider];
      }
    }
    for (const providerName of alreadyJudged) {
      judgeAccount.complete(judgeLegKey(cell.key, providerName), { reused: true });
    }
    if (alreadyJudged.size === rows.length) return; // every leg already scored in a prior session

    const timestamp = new Date().toISOString();
    // providersToCall omits any provider not wired (opts.judgeProviders) --
    // runJudgeMatrix records that leg as `deferred`, never throws for it
    // (see evals/judge/score.mjs's own header: "NOT dropped -- H5's
    // self-preference bias term needs both legs").
    const { results, deferred, costRows } = await runJudgeMatrix({
      pools: [{ poolKey: cell.key, arm: armWithId, briefText, candidates }],
      judgeModels,
      providers: providersToCall,
      store,
      seed: judgeSeed,
      mode: batch ? "batch" : "single",
      timestamp,
    });

    // buildJudgeMatrix (inside runJudgeMatrix) always returns BOTH provider
    // rows for this pool, regardless of `providersToCall` -- a row whose
    // provider we deliberately excluded above (because it's `alreadyJudged`)
    // comes back in `deferred` too (runJudgeMatrix sees no provider wired for
    // it and can't tell "already scored" from "never had a provider").
    // Skip anything already accounted for above, or `judgeAccount.complete`/
    // `.skip` would throw "already terminal; refusing to overwrite".
    for (const r of results) {
      if (alreadyJudged.has(r.judge_provider)) continue;
      const legKey = judgeLegKey(r.poolKey, r.judge_provider);
      if (r.state === "completed") judgeAccount.complete(legKey, { scores: r.scores });
      else judgeAccount.fail(legKey, r.failureKind, r.detail || "");
    }
    for (const d of deferred) {
      if (alreadyJudged.has(d.judge_provider)) continue;
      const legKey = judgeLegKey(d.poolKey, d.judge_provider);
      // A deferred leg (no provider wired for it) is a legitimate, terminal
      // outcome -- `skip()`, never `fail()`: FAILURE_KINDS has no entry that
      // honestly describes "no provider wired", and `harness_error` would be
      // a lie that pollutes summary.byKind. Distinct detail prefix
      // (`judge_deferred:`) keeps it visibly different from a budget skip.
      judgeAccount.skip(legKey, `judge_deferred:${d.judge_provider}:${d.reason}`);
    }

    // Route every judge costRow to the SAME accounting this cell's
    // generation spend uses (issue #68 requirement 2: "judge cost rows reach
    // recordActualSpend, so real judge spend counts against
    // runningTotalByProvider and can trip a per-provider ceiling"). Each row
    // is built EXACTLY ONCE by meterJudgeCall (inside runJudgeMatrix) and
    // already durably stored under its own `judge-call|...` key by the time
    // this line runs -- addCost()/recordActualSpend() never call store.put()
    // themselves, so this can never double-persist the same row under a
    // second store key (the exact double-count meterJudgeCall's own header
    // comment guards against).
    //
    // N5 (PR #76 review): this means `account.ledger` -- populated ONLY via
    // addCost(), see the generation branches below -- now carries BOTH
    // generation and judge cost rows under the SAME planned cellKey (a
    // judge costRow's `cellKey` is the poolKey, which equals the generating
    // cell's key). Harmless today: nothing reads `account.ledger` outside a
    // test, and `summary.spendByProvider` is derived from
    // `runningTotalByProvider` (recordActualSpend's own running total, see
    // above), never from `account.ledger`, so it is NOT silently mislabeled
    // "generation spend" by this. Flagged here so a FUTURE consumer of
    // `account.ledger` treats it as "every dollar this run's planned cells
    // spent, generation and judging both" -- not generation-only -- rather
    // than discovering the mix the hard way.
    for (const row of costRows) account.addCost(row);
    recordActualSpend(costRows);
  }

  // Reused cells already reached SOME terminal state in a prior session --
  // completed, failed, or (rarer) skipped. They still must appear in this
  // run's account so reconcile() sees a complete picture of "every cell this
  // spec calls for" (the additive design, lib/manifest.mjs), but they are NOT
  // re-priced, re-run, or re-written to the store; only acknowledged as
  // already-terminal. Read the ACTUAL prior state back from the store rather
  // than blindly marking every reused cell "completed" -- a cell that failed
  // last session is still failed; silently upgrading it to completed on
  // resume would corrupt the very failure-rate accounting §4.3 exists for.
  for (const cell of plan.reuse) {
    const priorRecord = store.get(cell.key); // { result, accounting: {state, kind?, detail?}, ... }
    const priorState = priorRecord.accounting;
    if (priorState.state === "completed") {
      // Restore the ORIGINAL stored result, not a synthetic placeholder --
      // downstream consumers of a reconciled RunAccount (e.g.
      // evals/metrics/operational.mjs's latencyPercentiles(), which requires
      // every completed cell's result to carry a numeric latencyMs) read
      // `result` off the account, not off the store. A stand-in like
      // `{ reused: true }` would silently break any metric computed over an
      // account that spans a resumed session -- which is the normal case
      // once a study runs across multiple sessions, the entire point of the
      // additive/resume design.
      account.complete(cell.key, priorRecord.result);
      // issue #68 AC4 -- the resume blind spot: a cell generated in a PRIOR
      // session (reused here for free) may not have been judged yet (either
      // because that session predates #68, or was interrupted before
      // judging ran). Judge it NOW, on this invocation, rather than leaving
      // it a silent $0/no-op forever. Only a cell whose PRIOR generation
      // actually completed has candidates to judge -- a reused `failed`
      // cell below is deliberately excluded.
      await judgePoolIfEnabled(cell, armsConfig.arms[cell.armId], priorRecord.result);
    } else if (priorState.state === "failed") {
      account.fail(cell.key, priorState.kind, priorState.detail || "");
      // A stored TRANSIENT failure can only be a LEGACY record -- written
      // before issue #90's fix, when every classified generation failure
      // went into the store under cell.key. Nothing this runner writes can
      // produce one any more. This RUN cannot re-attempt it -- nothing on
      // the run path removes a record -- and it is silently dragging an
      // environmental fault forward as though it were a measurement, so say
      // so out loud rather than letting a plausible-looking `failed=N` hide
      // it. As of issue #98 the remedy is a real command rather than a
      // hand-edit, so the warning names it.
      if (isTransientFailure(priorState.kind)) {
        log(
          `[run] WARNING: reused cell '${cell.key}' is a stored '${priorState.kind}' failure -- an environmental ` +
            `fault recorded before issue #90's fix, which this run cannot re-attempt. Clear it (its spend is ` +
            `preserved) with: node evals/run.mjs --prune --kinds transient --cfg ${cell.cfg} --apply   ` +
            `-- see docs/retrying-failed-cells.md.`,
        );
      }
    } else if (priorState.state === "skipped") {
      // This runner itself never persists a `skipped` record (see the
      // budget-skip comment below -- a budget skip is deliberately kept
      // store-absent so it stays retryable), so this branch is currently
      // unreached by anything runSpec() writes. It exists for a store
      // record written some OTHER way (a manual entry, a future harness
      // change) that legitimately reached `skipped` -- and dispatches on
      // the literal state string rather than an `else`, so an unrecognized
      // state value falls through to the explicit throw below instead of
      // being silently absorbed as "skipped".
      account.skip(cell.key, priorState.detail || "reused: previously skipped");
    } else {
      // Fail loud on a stored state outside lib/accounting.mjs's own
      // TERMINAL_STATES vocabulary -- e.g. a hand-edited or corrupted store
      // record -- rather than silently reclassifying it as a skip. Every
      // other place in RunAccount treats an unrecognized state/kind as a
      // hard error (see #assertPlanned and fail()'s FAILURE_KINDS check);
      // this path should not be the one exception that fails open.
      throw new Error(`runSpec: stored cell '${cell.key}' has an unrecognized accounting.state '${priorState.state}' -- expected one of ${TERMINAL_STATES.join(", ")}`);
    }
  }

  // Transient generation failures THIS INVOCATION declined to store (issue
  // #90), keyed by kind. Populated only by the todo loop's transient branch
  // -- see there for why this is not derived from summary.byKind.
  const notStoredTransientByKind = {};
  // ── Payment abort (issue #88) ────────────────────────────────────
  // Set (once) to `{ cellKey, detail, providers }` the first time a cell
  // fails `payment_required`. A sticky flag consulted at the TOP of the todo
  // loop, deliberately not a `break` and emphatically not a `throw`:
  //
  //   - `break` + a post-loop backfill over plan.todo would re-record cells
  //     that already reached a terminal state, and RunAccount#assertPlanned
  //     throws on exactly that.
  //   - `throw` would skip reconcile() entirely, losing the summary AND the
  //     ledger of money genuinely spent before the account ran dry.
  //
  // Consulted-at-the-top gives both ACs by construction: every remaining
  // planned cell still reaches exactly one terminal state (a classified
  // skip), and nothing already written is touched. It is the same shape the
  // `budget_exceeded` skip below already uses, for the same reason.
  let paymentAborted = null;

  const priceByKey = new Map(projection.breakdown.map((b) => [b.cellKey, b.usd]));
  // Projected per-provider cost for each todo cell, split slot-by-slot (see
  // the pre-flight block above) -- used to decide, BEFORE a cell runs,
  // whether admitting it would cross a provider's ceiling.
  const providerByKey = new Map(projection.breakdown.map((b) => [b.cellKey, b.byProvider || {}]));

  for (const cell of plan.todo) {
    if (paymentAborted) {
      // The account cannot pay. Marching this cell into the identical wall
      // would produce a failure that is not a datum about the arm, cost
      // wall-clock, and (post-#90) leave 180 attempt records saying nothing.
      // A skip is the honest record: we never tried.
      //
      // The reason string's category (everything before the first colon --
      // see RunAccount.reconcile) is `payment_required`, so the run summary
      // reads `skipped=180 (payment_required=180)` rather than an
      // undifferentiated count. The detail after the colon names the cell
      // that hit the wall so an operator can see WHERE the run stopped.
      //
      // NOTE on over-skipping in a mixed-provider grid: a refusal from one
      // provider aborts cells that would only have spent under the other.
      // That is the AC's stated behaviour ("aborts the remaining plan"), and
      // it is safe rather than lossy -- a skip is store-absent, so the next
      // invocation plans every one of these `todo` again. The provider list
      // is kept in the reason so the information is not thrown away.
      account.skip(
        cell.key,
        `payment_required: account cannot pay (first refusal at '${paymentAborted.cellKey}'` +
          (paymentAborted.providers ? `, providers: ${paymentAborted.providers}` : "") +
          ")",
      );
      continue;
    }
    // `priceByKey.get(cell.key) || 0` would mask two distinct situations as
    // the same silent zero: (a) a cell that legitimately costs $0 (falsy
    // zero -- fine), and (b) a cell missing from the pricer's breakdown
    // entirely, e.g. a bug in an INJECTED priceGrid that doesn't cover every
    // todo cell. In a budget-safety gate, (b) must fail loud -- a silently
    // free cell defeats the entire point of --max-spend admission control.
    if (!priceByKey.has(cell.key)) {
      throw new Error(`runSpec: priceGrid's breakdown is missing an entry for planned cell '${cell.key}' -- every todo cell must be priced`);
    }
    const cellCost = priceByKey.get(cell.key);

    // Per-provider admission control (issue #51): a cell is skipped once ANY
    // provider it spends under would cross ITS OWN ceiling -- checked as
    // `already-actually-spent + this-cell's-projected-share`, so the decision
    // uses REAL spend for every prior cell and only estimates the one cell
    // about to run (its actual cost isn't known until after the call).
    //
    // Walk the providers THIS CELL actually spends under (cellByProvider),
    // never the full set of configured ceilings -- a cell that doesn't touch
    // a given provider projects $0 for it, and once that OTHER provider's
    // ceiling has already been exceeded by real spend, `already > ceiling`
    // alone would wrongly trip on every subsequent cell regardless of which
    // provider it actually uses (issue #62 BLOCKER 1). Skipping only when the
    // cell's own projected share is positive AND pushes that provider over
    // its ceiling keeps the skip -- and the recorded `trippedProvider` name --
    // tied to a provider the cell genuinely spends under.
    let trippedProvider = null;
    if (maxSpendByProviderUsd) {
      const cellByProvider = providerByKey.get(cell.key) || {};
      for (const [provider, projected] of Object.entries(cellByProvider)) {
        if (!(provider in maxSpendByProviderUsd) || !(projected > 0)) continue;
        const ceiling = maxSpendByProviderUsd[provider];
        // Cumulative (issue #64): spend-to-date reconstructed from the store
        // BEFORE this invocation started, PLUS this invocation's real spend
        // so far -- never just the latter, which is what let a resumed run
        // restart its budget at zero.
        const already = (priorSpend.byProvider[provider] || 0) + (runningTotalByProvider[provider] || 0);
        if (already + projected > ceiling) {
          trippedProvider = provider;
          break;
        }
      }
    }

    if (trippedProvider || (maxSpendUsd !== undefined && priorSpend.totalUsd + runningTotal + cellCost > maxSpendUsd)) {
      // Budget-skipped: recorded via RunAccount as a classified skip, never
      // dropped from the plan (see reconcile()'s tally below and the AC's
      // own wording: "recorded skipped: budget_exceeded, never dropped").
      //
      // Deliberately NOT written to the store. A budget skip means "we never
      // even tried this cell", which is categorically different from a
      // provider-side `failed` cell (something was attempted and the
      // provider told us why it didn't work) -- and unlike a failure, it
      // should NOT survive as a durable, replayable outcome under this
      // configHash. If it were persisted, a later run with a higher
      // --max-spend would see it in store.keys() and planRun would report it
      // as `reuse` (append-only: cells are never silently re-run once
      // stored) -- permanently starving that cell of ever actually running.
      // Leaving it store-absent means the next invocation (any --max-spend,
      // including none) sees it as `todo` again, which is the only sane
      // resume behavior for "we chose not to spend on this yet."
      account.skip(cell.key, trippedProvider ? `budget_exceeded:${trippedProvider}` : "budget_exceeded");
      continue;
    }
    // `runningTotal` is no longer bumped by this cell's PROJECTED `cellCost`
    // here (PR #76 fix round, Sentry HIGH finding) -- it is now maintained
    // exclusively as ACTUAL spend-so-far, updated inside recordActualSpend()
    // below, exactly mirroring `runningTotalByProvider`. The comparison
    // above and the NEXT cell's own admission check still add `cellCost`
    // (this cell's own PROJECTED share) on top of `runningTotal` (everything
    // ACTUAL so far) -- the same already-actual + projected-this-cell shape
    // the per-provider check uses just above. Before this fix, `runningTotal`
    // accumulated PROJECTED cost at admission time and was NEVER updated by
    // real spend afterward, so judge spend (added only to
    // `runningTotalByProvider` by recordActualSpend) never reached the
    // GLOBAL `--max-spend` ceiling at all.

    const arm = armsConfig.arms[cell.armId];
    if (!arm) throw new Error(`runSpec: cell '${cell.key}' references unknown arm '${cell.armId}'`);

    const timestamp = new Date().toISOString();
    let response;
    try {
      response = await provider.generate(cell, arm, { mode: batch ? "batch" : "single", timestamp });
      // Validate the shape regardless of whether the provider is our own
      // MockProvider (which already self-validates) or a future real
      // adapter -- a malformed response from ANY provider must surface as a
      // classified harness_error, not as an uncaught TypeError three lines
      // down when we try to read `.result.candidates` off garbage.
      assertValidProviderResponse(response);
    } catch (err) {
      // A THROWING provider is our own bug surfacing (or an unmodeled
      // transport failure the provider should have classified itself) --
      // classify it as harness_error rather than letting it crash the run
      // and silently drop every cell after it. Still terminal, still
      // reconciled, still a datum.
      //
      // Nothing is written under cell.key here, and as of issue #90 that is
      // the STATED rule rather than an accident of where this `continue`
      // sits: harness_error is in TRANSIENT_FAILURE_KINDS, so once our bug
      // is fixed the cell is planned `todo` again instead of carrying our
      // defect forward as a permanent property of the arm. No cost rows
      // exist to persist -- the provider threw before reporting any tokens.
      account.fail(cell.key, "harness_error", `provider threw: ${err && err.message}`);
      continue;
    }

    if (response.terminalState === "completed") {
      const genCostRows = costRowsFor(cell.key, response.tokens, timestamp);

      // ── Pool metrics (issue #85), computed BEFORE the single store.put()
      // for this cell -- lib/store.mjs is append-only, so distinct_k/pool
      // must already be part of `result` at the moment this cell is FIRST
      // (and only ever) written; there is no second write to add them
      // later. Money safety is instead guaranteed by computeCellMetrics()
      // NEVER THROWING (it classifies failure and returns it -- see that
      // function's own header) and by metering the embedder's actual token
      // delta in a `finally` regardless of outcome, so a metrics failure
      // can never lose the record of what the embedder call itself
      // consumed. Skipped entirely when metrics are disabled
      // (opts.embedder unset) -- unchanged from pre-#85 behavior.
      let metrics = null;
      if (metricsEnabled) {
        metrics = await computeCellMetrics(cell, response.result && response.result.candidates, timestamp);
      }
      const costRows = metrics ? [...genCostRows, ...metrics.costRows] : genCostRows;

      if (metrics && !metrics.ok) {
        // ── PR #86 review fix round -- do NOT store this cell under
        // cell.key at all ────────────────────────────────────────────────
        // The original approach here stored a `failed` record under
        // cell.key on a metrics failure. That is WRONG: lib/manifest.mjs's
        // planRun(spec, storedKeys) receives ONLY keys -- it has no access
        // to accounting.state and structurally cannot tell a completed cell
        // from a failed one. Once cell.key exists in the store AT ALL, every
        // future invocation classifies it `reuse`, forever (the store is
        // append-only -- there is no delete, and put() throws on
        // same-key/different-content). A transient Voyage 429 during
        // metrics would therefore PERMANENTLY destroy a cell whose
        // generation was already paid for, with no way to ever retry it --
        // not by re-running, not by resuming. Worse: the loss is correlated
        // with arm (bigger pools embed more tokens -> higher 429
        // probability -> panel arms lose cells preferentially), which
        // confounds exactly the panel-vs-solo comparison H1 tests. This is
        // the same shape of bug #76 fixed for judge retries (a fixed judge-
        // call key collided on retry and bricked the store) -- see
        // meterJudgeCall's attempt-scoped key in evals/judge/gate.mjs.
        //
        // The fix: leave cell.key OUT of the store entirely, so the next
        // invocation's planRun still sees it as `todo` and retries it (a
        // fresh generation call -- genuinely re-spending, which is correct
        // and honest, exactly the principle already established for judge
        // retries). The money already spent -- this cell's real generation
        // tokens, plus whatever the embedder actually consumed before
        // failing -- is preserved under its OWN attempt-scoped key
        // (recordMetricsAttemptFailure, mirroring meterJudgeCall exactly),
        // never lost and never double-counted against a later successful
        // retry (each attempt gets a new, non-colliding key).
        recordMetricsAttemptFailure(store, { cell, costRows, detail: metrics.detail, timestamp });
        recordActualSpend(costRows);
        // Skipped, not failed: RunAccount.skip() is a legitimate terminal
        // state for THIS invocation's reconcile() (every planned cell must
        // still reach exactly one terminal state -- this cell is not
        // silently dropped from the run's own accounting), but -- exactly
        // like the pre-existing `budget_exceeded` skip below -- writes
        // NOTHING under cell.key, so the store-level retryability described
        // above holds regardless of what this invocation's summary reports.
        account.skip(cell.key, `metrics_failed: ${metrics.detail}`);
        continue; // no candidates survive to judge -- nothing was ever stored
      }

      const finalResult = metrics ? { ...response.result, ...metrics.resultPatch } : response.result;
      account.complete(cell.key, finalResult);
      for (const row of costRows) account.addCost(row);
      // issue #74 -- store.put() BEFORE recordActualSpend(): the API call
      // already succeeded and spent real money by this point, so the result
      // and its cost row must be durably written BEFORE the fail-loud
      // missing-rate guard (issue #62 MEDIUM) gets a chance to throw.
      // Previously recordActualSpend() ran first, so a rate-table gap
      // discarded an already-paid-for cell's entire record (never reaching
      // store.put()) and aborted the rest of the run -- silently
      // under-counting real spend against the very ceiling meant to bound
      // it. The ordering is the fix, per the issue's own "suggested fix
      // direction": the throw-and-abort behavior on a missing rate is
      // UNCHANGED (still fails loud, still aborts this invocation) -- only
      // WHEN it can fire relative to persistence moved. issue #85 extends
      // this SAME ordering to metrics: this store.put() already carries
      // distinct_k/pool (computed above, before this write) and every
      // costRow (generation AND embedder), so a missing-rate throw below
      // still can never discard an already-paid-for, already-measured cell.
      store.put({
        key: cell.key,
        armId: cell.armId,
        briefId: cell.briefId,
        replicate: cell.replicate,
        cfg: cell.cfg,
        result: finalResult,
        resolvedModels: resolvedModelsFor(arm),
        accounting: { state: "completed" },
        costRows,
      });
      recordActualSpend(costRows);
      // issue #68 -- judge this pool now, per cell, so a per-provider
      // ceiling stays responsive to judge spend for the NEXT cell's
      // admission decision (see the per-cell loop's projected-vs-actual
      // comparison above, which reads runningTotalByProvider between cells).
      await judgePoolIfEnabled(cell, arm, finalResult);
    } else {
      // response.terminalState === "failed" -- a classified provider
      // failure surfaces as a `failed` cell, never a missing one.
      //
      // ── Whether it also becomes a PERMANENT cell is the second, separate
      // question (issue #90) ────────────────────────────────────────────────
      // Both branches below `fail()` the cell on this invocation's account:
      // a failure is a datum, it counts in summary.byKind, and reconcile()
      // sees exactly one terminal state for this cell either way. What
      // differs is PERSISTENCE, and the split is
      // lib/accounting.mjs's INTRINSIC/TRANSIENT sets -- read that comment
      // for why each kind sits where it does.
      //
      // The mechanism is the one already established for metrics failures
      // just above (and for judge retries in evals/judge/gate.mjs's
      // meterJudgeCall): keep `cell.key` out of the store so planRun() plans
      // it `todo` again, and persist the money under an attempt-scoped key
      // so nothing already paid for is lost. This branch is the generation
      // counterpart the metrics defence was missing.
      account.fail(cell.key, response.failureKind, response.detail || "");
      const costRows = costRowsFor(cell.key, response.tokens, timestamp);
      for (const row of costRows) account.addCost(row);
      // issue #74 -- same store.put()-before-recordActualSpend reordering
      // as the completed branch above: a FAILED cell can still have
      // consumed real tokens (see costRowsFor's caller comment), and those
      // must survive even if recordActualSpend then throws. Both #90
      // branches below preserve that ordering.
      if (isPaymentFailure(response.failureKind)) {
        // ── The account cannot pay (issue #88) ───────────────────────────
        // PERSISTENCE takes the transient treatment, deliberately: an empty
        // credit balance is not a fact about the arm, so nothing goes under
        // cell.key and a later run against a funded account plans this cell
        // `todo` again. The money this attempt did spend is durable under
        // its own attempt-scoped key, exactly as for a 429. (README.md and
        // docs/retrying-failed-cells.md already promise this outcome for "an
        // empty credit balance"; before this branch the code did the
        // opposite, because the refusal was misclassified transport_error.)
        //
        // CONTINUATION is where it differs from a transient fault: set the
        // sticky abort flag so the top of this loop skips every remaining
        // cell. Deliberately NOT counted in notStoredTransientByKind -- that
        // notice tells the operator to "re-run the same command", which is
        // wrong advice while the account is dry. It gets its own line below.
        recordGenerationAttemptFailure(store, {
          cell,
          costRows,
          kind: response.failureKind,
          detail: response.detail || "",
          resolvedModels: resolvedModelsFor(arm),
        });
        const cellByProvider = providerByKey.get(cell.key) || {};
        paymentAborted = {
          cellKey: cell.key,
          detail: response.detail || "",
          providers: Object.keys(cellByProvider)
            .filter((p) => cellByProvider[p] > 0)
            .join(", "),
        };
      } else if (isTransientFailure(response.failureKind)) {
        // Environmental fault. NOTHING is written under cell.key, so the
        // next invocation re-attempts it (genuinely re-spending, which is
        // correct and honest). The attempt -- its kind, its detail, and
        // every token it consumed -- is durable under its own key.
        //
        // Tallied HERE, in the branch that actually declined to store the
        // cell, rather than derived from summary.byKind at the end. byKind
        // counts the reuse loop's failures too, and a LEGACY stored
        // transient failure (written before this fix) lands in it -- so a
        // notice driven off byKind would tell an operator to re-run a cell
        // that is permanently `reuse` and will never be re-attempted. That
        // is the exact ambiguity the notice exists to remove.
        notStoredTransientByKind[response.failureKind] = (notStoredTransientByKind[response.failureKind] || 0) + 1;
        recordGenerationAttemptFailure(store, {
          cell,
          costRows,
          kind: response.failureKind,
          detail: response.detail || "",
          resolvedModels: resolvedModelsFor(arm),
        });
      } else {
        // Cell-intrinsic observation about the arm (parse_failure,
        // empty_pool, refusal). This IS the measurement; storing it under
        // cell.key is the point, and re-attempting it would be resampling
        // until the arm looks better than it is.
        store.put({
          key: cell.key,
          armId: cell.armId,
          briefId: cell.briefId,
          replicate: cell.replicate,
          cfg: cell.cfg,
          result: { failed: true, failureKind: response.failureKind },
          resolvedModels: resolvedModelsFor(arm),
          accounting: { state: "failed", kind: response.failureKind, detail: response.detail || "" },
          costRows,
        });
      }
      recordActualSpend(costRows);
      // No candidates on a failed generation cell -- nothing to judge.
    }
  }

  // The gate: reconcile() throws unless every planned cell reached exactly
  // one terminal state. Called before any statistic is computed -- there is
  // none computed in this module, but the summary below is derived from
  // reconcile()'s own tally, so it is definitionally post-gate.
  const summary = account.reconcile();
  // judge (issue #68 AC5): a SEPARATE reconcile() over the judge-leg
  // account. If any planned judge leg never reached a terminal state, THIS
  // throws -- exactly like the generation `account.reconcile()` above -- so
  // the run as a whole still fails on an unjudged pool rather than silently
  // passing (see the judgeAccount construction comment above for why this is
  // a second account rather than folded into `summary.planned/completed/...`).
  // `null` when judging was never enabled this invocation (opts.judgeModels
  // unset) -- `null` here means "not applicable", never "computed as zero".
  summary.judge = judgeAccount ? judgeAccount.reconcile() : null;
  // spendByProvider: the ACTUAL per-provider total THIS INVOCATION spent,
  // derived from real tokens_by_model (issue #51) -- exposed on the summary
  // so a caller (report, next --max-spend-<provider> invocation) can see
  // what this session cost per provider, not just the pre-flight estimate.
  // Deliberately kept THIS-INVOCATION-ONLY -- existing callers/tests read it
  // that way (see runner.test.mjs's issue #62 BLOCKER 2 test, which asserts
  // it against an independently-computed per-session expectation).
  summary.spendByProvider = runningTotalByProvider;
  // cumulativeSpendByProvider / cumulativeSpendUsd / cumulativeNonProviderSpendUsd
  // / cumulativeNonProviderModels (issue #64, revised per PR #72 review): the
  // study's TOTAL spend to date -- every dollar the store's cost rows
  // account for, across every configHash and every invocation that ever
  // ran, PLUS this invocation's own actual spend -- reconstructed from
  // durable data, not an in-memory counter. This is what a resumed run's
  // ceiling is actually enforced against above (see `priorSpend` + the
  // per-cell admission loop); these fields expose the same totals for a
  // report or the next invocation, rather than making a caller re-derive
  // them. See `spendToDate`'s own header comment for the full "what this
  // measures given #68 and the resume blind spot" caveat -- it applies
  // identically to these fields, since they are `priorSpend` plus this
  // run's own real spend and nothing more.
  //
  // `null` when no ceiling was requested this invocation (`priorSpend` is
  // `null` -- see its own comment above): the store's full history was
  // deliberately never read, so there is nothing honest to report here.
  // `null` here means "not computed", never "computed as zero" -- call
  // `spendToDate(store)` directly for these figures outside a ceiling-gated
  // run.
  //
  // BASIS (PR #72 review, HIGH -- previously two fields both called
  // "cumulative spend" disagreed on whether non-provider/embedder spend
  // counted): `--max-spend` has ALWAYS admission-controlled against
  // `priorSpend.totalUsd` (see the per-cell loop above), which is
  // `priceRows().totalUsd` -- ALL priced spend, embedder included, because
  // a GLOBAL ceiling is a total-dollars backstop, not scoped to any one
  // provider (this predates issue #64 and is unchanged here). So
  // `cumulativeSpendUsd` below is defined to match that basis exactly:
  // provider spend PLUS non-provider spend, the same total `--max-spend`
  // gates on. `cumulativeSpendByProvider`/`cumulativeNonProviderSpendUsd`
  // are its breakdown, on the SAME (provider-only vs. non-provider-only)
  // split `--max-spend-<provider>` gates on -- so every reported figure now
  // matches the admission control it corresponds to, and
  // `cumulativeSpendUsd === sum(cumulativeSpendByProvider) + cumulativeNonProviderSpendUsd`
  // always holds. See docs/PREREGISTRATION.md §12 for the same decision
  // stated for an operator reading the CLI output, not the code.
  if (priorSpend) {
    const cumulativeSpendByProvider = { ...priorSpend.byProvider };
    for (const [provider, usd] of Object.entries(runningTotalByProvider)) {
      cumulativeSpendByProvider[provider] = (cumulativeSpendByProvider[provider] || 0) + usd;
    }
    const cumulativeNonProviderSpendUsd = priorSpend.excludedNonProviderUsd + runningNonProviderTotal;
    summary.cumulativeSpendByProvider = cumulativeSpendByProvider;
    summary.cumulativeNonProviderSpendUsd = cumulativeNonProviderSpendUsd;
    summary.cumulativeNonProviderModels = [...new Set(priorSpend.excludedNonProviderModels)];
    summary.cumulativeSpendUsd = Object.values(cumulativeSpendByProvider).reduce((a, b) => a + b, 0) + cumulativeNonProviderSpendUsd;
  } else {
    summary.cumulativeSpendByProvider = null;
    summary.cumulativeNonProviderSpendUsd = null;
    summary.cumulativeNonProviderModels = null;
    summary.cumulativeSpendUsd = null;
  }
  // Skip-reason breakdown (PR #86 review): summary.skippedByReason (from
  // RunAccount.reconcile(), see lib/accounting.mjs) already distinguishes
  // `budget_exceeded` from `metrics_failed` from any other skip reason --
  // this just surfaces it in the same log line the bare `skipped=N` count
  // was already printed on, so a run reporting `skipped=30` is never
  // ambiguous between "you hit your ceiling" and "the embedder is failing"
  // at exactly the moment (#8/Phase 2a's go/no-go) that distinction matters.
  const skipBreakdown = Object.entries(summary.skippedByReason)
    .map(([reason, n]) => `${reason}=${n}`)
    .join(", ");
  log(
    `[run] planned=${summary.planned} completed=${summary.completed} failed=${summary.failed} skipped=${summary.skipped}` +
      (skipBreakdown ? ` (${skipBreakdown})` : ""),
  );
  // Retryable-failure notice (issue #90). Built from the todo loop's own
  // tally of cells it declined to store -- NOT from summary.byKind, which
  // also counts legacy stored transient failures restored by the reuse loop
  // and would therefore promise a re-attempt that can never happen. Kept out
  // of reconcile()'s return so the summary shape every other caller reads is
  // untouched. `failed=N` alone cannot tell an operator whether the night was
  // lost to rate limits (re-run it) or to the arms genuinely refusing (that
  // IS the result) -- the exact ambiguity that cost the #8 study a dataset.
  // Payment abort notice (issue #88). Loud and separate from the retryable
  // notice below, because the operator action is different in kind: a
  // rate-limited night says "re-run the same command"; a dry account says
  // "fund the account, THEN re-run". Surfaced on the summary as well as
  // logged, so a caller (evals/run.mjs, a report) can branch on the fact
  // rather than scrape the log. `null` means no payment abort occurred --
  // never "we did not check".
  summary.paymentAbort = paymentAborted
    ? {
        cellKey: paymentAborted.cellKey,
        detail: paymentAborted.detail,
        providers: paymentAborted.providers,
        skipped: summary.skippedByReason.payment_required || 0,
      }
    : null;
  if (paymentAborted) {
    log(
      `[run] ABORTED: the provider refused on billing/credit at cell '${paymentAborted.cellKey}'` +
        (paymentAborted.providers ? ` (providers: ${paymentAborted.providers})` : "") +
        `. ${summary.paymentAbort.skipped} remaining cell(s) were skipped, not attempted -- ` +
        `every one of them would have hit the identical wall. Nothing was stored under those ` +
        `cell keys, so fund the account and re-run the same command to pick up where this stopped ` +
        `(spend already incurred is preserved). Provider detail: ${paymentAborted.detail}`,
    );
  }
  const retryable = Object.entries(notStoredTransientByKind);
  if (retryable.length) {
    const n = retryable.reduce((a, [, count]) => a + count, 0);
    log(
      `[run] ${n} of those failure(s) were environmental (${retryable.map(([k, c]) => `${k}=${c}`).join(", ")}) ` +
        `and were NOT stored under their cell keys -- re-run the same command to re-attempt them ` +
        `(spend already incurred is preserved; see docs/retrying-failed-cells.md).`,
    );
  }
  // Attempt-record retention notice (issue #98). A DELIBERATE non-mutation:
  // the run reports that a cell is over the retention bound and names the
  // command, but never prunes. Compaction removes records, and a removal
  // that every ordinary invocation can reach is a removal that eventually
  // happens when nobody meant it to -- the store's one delete path stays
  // behind an explicit operator command. `store.keys()` is index-only
  // (lib/store.mjs) and was already read to plan this run, so the check
  // costs nothing on top.
  const attemptCounts = new Map();
  for (const key of store.keys()) {
    const parsed = parseAttemptKey(key);
    if (!parsed) continue;
    const gk = `${parsed.family} ${parsed.cellKey}`;
    attemptCounts.set(gk, (attemptCounts.get(gk) || 0) + 1);
  }
  const overRetention = [...attemptCounts.values()].filter((n) => n > DEFAULT_ATTEMPT_RETENTION).length;
  if (overRetention) {
    log(
      `[run] NOTE: ${overRetention} cell(s) hold more than ${DEFAULT_ATTEMPT_RETENTION} attempt records each. Their spend is ` +
        `counted correctly, but spendToDate() parses every stored body, so the pile slows every ceiling-gated run. ` +
        `Fold them (money preserved, verified) with: node evals/run.mjs --prune   (add --apply to commit).`,
    );
  }
  return { summary, account };
}
