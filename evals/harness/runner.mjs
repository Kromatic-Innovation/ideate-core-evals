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
// The attempt-record key grammar (issues #98, #108). It lives in the store
// module because evals/judge/gate.mjs needs the identical next-attempt
// derivation and cannot import THIS module without closing a cycle -- see
// that block's own comment in lib/store.mjs.
import {
  ATTEMPT_FAMILIES,
  BATCH_RESUME_FAMILY,
  parseAttemptKey,
  nextAttemptNumber,
  readBatchResumeRecord,
  writeBatchResumeRecord,
} from "../../lib/store.mjs";
import {
  RunAccount,
  costRow,
  TERMINAL_STATES,
  FAILURE_KINDS,
  TRANSIENT_FAILURE_KINDS,
  PAYMENT_FAILURE_KINDS,
  isTransientFailure,
  isPaymentFailure,
} from "../../lib/accounting.mjs";
// realizedAgents (issue #102): ideate-core's own realized-agent bookkeeping,
// normalized and validated. Imported rather than re-derived so the runner's
// backstop and the providers' own guard agree by construction on what "an
// attempted agent that did not contribute" means -- see provider.mjs's "THE
// UNDERSIZED-POOL RULE" block for the rule itself and for why the denominator
// is ideate-core's attempted count rather than arm.slots.length.
import { assertValidProviderResponse, realizedAgents } from "./provider.mjs";
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
 *
 * `pricingRegime` (issue #119) stamps the FACT of which rate this call must
 * price at -- "batch" or "single" -- onto the row at write time, covering
 * BOTH shapes (a `tokens_by_model` row is one generation call spanning
 * several models, all made under the SAME provider mode, so one regime value
 * for the whole row is correct, exactly like `billing_mode` already applies
 * uniformly across a `tokens_by_model` row).
 *
 * Passing the CURRENT invocation's `pricingLever` is correct even for a
 * REPLAYED response: `loadBatchResumeState` above refuses to hand back
 * replay state whose recorded `pricingLever` disagrees with this
 * invocation's (see that function's header) -- so by the time `response`
 * reaches here, whatever regime the tokens were actually billed under is
 * GUARANTEED to equal `pricingLever`, replayed or freshly submitted alike.
 */
function costRowsFor(cellKey, tokens, timestamp, pricingRegime) {
  if (!tokens) return [];
  const billing_mode = "api"; // this study is real metered spend (§7)
  if (tokens.tokens_by_model) {
    return [costRow({ cellKey, timestamp, billing_mode, pricing_regime: pricingRegime, tokens_by_model: tokens.tokens_by_model })];
  }
  if (tokens.model) {
    return [costRow({ cellKey, timestamp, billing_mode, pricing_regime: pricingRegime, ...tokens })];
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

// ── Batch-resume state, runner side (issue #103) ──────────────────────────
//
// The store I/O half of resume. The provider does none of its own: it is
// handed `{replies, outstanding}` and hands back an updated copy, the same way
// it is handed a cell and hands back tokens.

/** The pricing LEVER a given invocation's spend lands under. Not `billing_mode`
 *  -- see lib/store.mjs's #103 header for why those are different axes and why
 *  conflating them mis-attributes spend by roughly 2x. */
function pricingLeverFor(batch) {
  return batch ? "batch" : "single";
}

/**
 * The replay state to hand the provider for `cell`, or null to start clean.
 *
 * Returns null -- deliberately choosing to RE-SPEND -- when the stored replies
 * were produced under a different pricing lever than this invocation runs
 * under. That is the AC4 hazard in its sharpest form: `lib/price.mjs` resolves
 * batch-vs-single from a flag the CALLER passes, not from anything on the row,
 * and `spendToDate()` passes ONE flag for the whole store. Replaying
 * batch-produced replies into a `--no-batch` run would therefore attribute
 * that spend at roughly TWICE what it cost -- not double-counted, which a
 * reconciliation would catch, but priced at the wrong RATE, which looks
 * entirely plausible in a total. Money accounted correctly beats money saved,
 * so the mismatch declines to replay and says so out loud.
 *
 * ── #119 revisit: still necessary, NOT relaxed ────────────────────────────
 * Issue #119 asked whether this guard is now over-strict, now that a cost
 * row carries its own `pricing_regime` instead of relying on a store-wide
 * flag. It is not, and the reason is a granularity mismatch this function's
 * own signature exposes: `pricingLever` here is ONE value for the whole
 * invocation, and `costRowsFor` stamps that ONE value onto a whole
 * response's cost row(s) (see its own header -- correct today only BECAUSE
 * this guard makes "replayed" and "this invocation's mode" the same value
 * whenever a reply is actually replayed). A resumed cell's `response` can in
 * principle mix REPLAYED batch-produced replies with NEWLY-submitted
 * current-mode replies within the SAME response (some outstanding batch
 * handles resolve, others are re-issued) -- nothing between the provider and
 * `costRowsFor` currently tracks which reply came from which regime at that
 * finer grain. Relaxing this guard would let exactly that mixed response
 * through, and `costRowsFor` would still stamp its ONE row with the CURRENT
 * invocation's `pricingLever` -- silently mis-pricing whichever replies were
 * actually replayed from the other regime, reintroducing the ~2x hazard
 * this guard exists to prevent, just moved one level down. Relaxing it
 * safely would require the provider layer to report, per reply, which
 * regime it actually came from -- a real change, out of this issue's stated
 * scope ("one field on costRow(), plus reading it in priceRows"). No test
 * added here proves relaxation safe, so per this issue's own instruction the
 * guard is LEFT AS IS.
 */
function loadBatchResumeState(store, cell, pricingLever, log) {
  const record = readBatchResumeRecord(store, cell.key);
  if (!record || record.retired) return null;
  if (record.pricingLever !== pricingLever) {
    log(
      `[resume] cell '${cell.key}' has ${Object.keys(record.replies).length} recoverable repl(y/ies) recorded under ` +
        `pricingLever='${record.pricingLever}', but this invocation is running '${pricingLever}'. NOT replaying them: ` +
        "batch and non-batch spend price ~2x apart and the ledger carries no per-row record of which lever a row ran " +
        `under, so replaying across the boundary would mis-attribute real spend. Re-run without --no-batch to use them.`,
    );
    return null;
  }
  const replyCount = Object.keys(record.replies).length;
  if (replyCount || record.outstanding.length) {
    log(
      `[resume] cell '${cell.key}': ${replyCount} already-paid-for repl(y/ies) available for replay, ` +
        `${record.outstanding.length} batch handle(s) to re-poll.`,
    );
  }
  return { replies: record.replies, outstanding: record.outstanding };
}

/** Append this cell's updated replay state. No-op when there is nothing worth
 *  replaying, so a cell that failed before any reply landed writes nothing. */
function persistBatchResumeState(store, cell, resume, pricingLever, log) {
  if (!resume || typeof resume !== "object") return;
  const replies = resume.replies || {};
  const outstanding = Array.isArray(resume.outstanding) ? resume.outstanding : [];
  if (!Object.keys(replies).length && !outstanding.length) return;
  writeBatchResumeRecord(store, {
    cellKey: cell.key,
    cfg: cell.cfg,
    replies,
    outstanding,
    pricingLever,
    detail:
      `${Object.keys(replies).length} recoverable repl(y/ies), ${outstanding.length} outstanding batch handle(s) ` +
      "-- replayed instead of re-submitted on the next invocation (issue #103)",
  });
  log(
    `[resume] cell '${cell.key}': recorded ${Object.keys(replies).length} repl(y/ies) and ${outstanding.length} ` +
      "batch handle(s) so the next invocation does not pay for them again.",
  );
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
//             `pruned-cell|cell=…|attempt=N` record, which is exactly what
//             #90 does for a live transient failure, applied retroactively.
//             A legacy store is thereby not merely repaired, it is brought
//             to the shape #90 would have written in the first place.
//             `pruned-cell` is itself one of ATTEMPT_FAMILIES (issue #115),
//             so its own records are bounded by the SAME compaction below —
//             see `salvageEvictedCellSpend` for the allocator/idempotency
//             pair that had to move together to make that safe.
//   COMPACT — several attempt records for one cell are folded into ONE
//             record whose cost rows are the per-(cell, billing mode, model)
//             SUM of theirs. Count falls; money is identical.
//   SUPERSEDE — every `batch-replay` record for a cell but the highest-
//             attempt one is removed outright, no fold and no salvage
//             (issue #117). Safe because the family always carries
//             `costRows: []` (enforced by `writeBatchResumeRecord`), and
//             correct because a batch-replay record is read only by
//             highest-attempt-wins (`readBatchResumeRecord`) -- an older one
//             is pure dead weight the moment a newer one exists.
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

/** The attempt-record key grammar is defined in lib/store.mjs (imported at
 *  the top of this module) and re-exported here unchanged, so every existing
 *  importer of `ATTEMPT_FAMILIES` / `parseAttemptKey` / `nextAttemptNumber`
 *  from the runner keeps working and the prune policy below still reads as
 *  one self-contained section. `judge-call` is one of the families as of
 *  #108: same record shape, same unbounded growth, and now the same
 *  max+1 numbering rather than gate.mjs's old key COUNT. */
export { ATTEMPT_FAMILIES, parseAttemptKey, nextAttemptNumber };

/** Family carrying cost rows salvaged off a cell record the prune evicted. */
const PRUNED_CELL_FAMILY = "pruned-cell";

/** Default retention window: how many attempt records per cell per family
 *  survive a compaction un-folded. 5 is "enough to read the last few bad
 *  nights out of the store by hand" — the diagnostic value of an individual
 *  attempt record decays fast, while its money does not decay at all. */
export const DEFAULT_ATTEMPT_RETENTION = 5;

/** Default retention window for the SUPERSEDE operation (issue #117): how
 *  many `batch-replay` records per cell survive un-removed. Deliberately its
 *  OWN knob, not `keepAttempts` -- and deliberately a much smaller default
 *  (1, not 5).
 *
 *  The two record shapes look alike (same key grammar, same max+1
 *  numbering) but differ in exactly the ways that make one number wrong for
 *  both: an attempt record is COMPACTED (folded into a cheap summed cost
 *  row, so keeping several costs almost nothing), while a batch-replay
 *  record is SUPERSEDED outright (no fold exists for a batch handle plus
 *  full recovered reply text, so every kept record costs its full size).
 *  And unlike an attempt record, an older batch-replay record carries no
 *  information a newer one doesn't already shadow -- `readBatchResumeRecord`
 *  only ever reads the highest-attempt one (see its own header), so a
 *  retained older record is not "the last few bad nights read by hand", it
 *  is dead weight from the moment a newer one exists. 1 -- keep only the
 *  record resume would actually read -- is therefore the natural default,
 *  not merely a smaller version of 5. */
export const DEFAULT_BATCH_REPLAY_RETENTION = 1;

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
 * `(cellKey, billing_mode, pricing_regime, model)` for a single-model row,
 * and `(cellKey, billing_mode, pricing_regime, <the exact model key-set>)`
 * for a `tokens_by_model` row. A `tokens_by_model` row is never reshaped into
 * N single-model rows: that would be an untested assumption about how
 * `priceRow` treats the two shapes, and this function's whole job is to not
 * assume.
 *
 * `pricing_regime` joined the group key in #119: two rows that would
 * otherwise fold together (same cell, billing mode, model) but were billed
 * under DIFFERENT regimes must never be summed into one row — that row could
 * only carry ONE `pricing_regime`, so folding across a mismatch would either
 * silently overwrite one row's regime with the other's (mis-pricing the
 * overwritten one by ~2x on the next read) or fabricate a regime for
 * whichever row lacked one. A row with NO `pricing_regime` at all (a legacy
 * row) forms its own group too, for the identical reason: it must never be
 * folded together with a fact-bearing row, which would launder a recorded
 * fact and a stated assumption into one indistinguishable number. Because
 * `pricing_regime` (present or absent) is read straight off `row` before any
 * folding happens, this falls out of adding it to the key -- no separate
 * "same regime" check is needed.
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
    // `pricing_regime` is pulled out EXPLICITLY, never left to fall into
    // `...tokens` -- `sumTokensInto` below only ever copies
    // FOLDABLE_TOKEN_FIELDS, so a regime left inside `tokens` would be
    // silently dropped off every folded row, quietly turning a fact-bearing
    // row back into a legacy-shaped one (issue #119).
    const { cellKey, timestamp, billing_mode, pricing_regime, model, tokens_by_model, ...tokens } = row;
    if (model && !tokens_by_model && foldableTokens(tokens)) {
      const gk = JSON.stringify(["model", cellKey, billing_mode, pricing_regime, model]);
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { cellKey, billing_mode, pricing_regime, model, timestamp, tokens: {} }));
      if (timestamp > g.timestamp) g.timestamp = timestamp;
      sumTokensInto(g.tokens, tokens);
      continue;
    }
    if (tokens_by_model && !model && Object.values(tokens_by_model).every((t) => t && typeof t === "object" && foldableTokens(t))) {
      const models = Object.keys(tokens_by_model).sort();
      const gk = JSON.stringify(["by_model", cellKey, billing_mode, pricing_regime, models]);
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { cellKey, billing_mode, pricing_regime, tokens_by_model: {}, timestamp }));
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
    // `pricing_regime` is only spread onto the rebuilt row when the GROUP
    // actually carried one -- `costRow()` treats `undefined` as "omit the
    // field entirely" (see its own header), so a group folded from legacy
    // rows (no regime) produces another legacy row, not a fabricated one.
    const regime = g.pricing_regime !== undefined ? { pricing_regime: g.pricing_regime } : {};
    foldedRows.push(
      g.tokens_by_model
        ? costRow({ cellKey: g.cellKey, timestamp: g.timestamp, billing_mode: g.billing_mode, ...regime, tokens_by_model: g.tokens_by_model })
        : costRow({ cellKey: g.cellKey, timestamp: g.timestamp, billing_mode: g.billing_mode, ...regime, model: g.model, ...g.tokens }),
    );
  }
  if (foldedRows.length >= rows.length) return { rows, folded: false, reason: "fold would not reduce the row count" };

  // ── Verify, then commit ───────────────────────────────────────────────────
  // `{ batch }` is now (issue #119) a FALLBACK ONLY -- lib/price.mjs's
  // priceRow/priceRows read `pricing_regime` straight off each row when
  // present, and consult this option solely for rows that lack it. Since
  // every row in one GROUP now shares an identical `pricing_regime` (it is
  // part of the fold's own group key, just above), this option only ever
  // matters for a group folded entirely from legacy (regime-less) rows --
  // and it is applied IDENTICALLY to `before` and `after`, so it cannot be
  // the source of a price mismatch between them either way.
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
 *   @param {string[]} [opts.kinds]      select FAILED cells whose stored
 *     `accounting.kind` is one of these (requires reading those bodies — the
 *     index carries `state`, not `kind`). DEFAULTS to the store-absent sets
 *     (`TRANSIENT_FAILURE_KINDS` + `PAYMENT_FAILURE_KINDS`), so an intrinsic
 *     observation is never evicted unless it is asked for by name — see the
 *     `kindFilter` comment in the body.
 *   @param {string[]} [opts.states=["failed"]] select cells in these terminal
 *     states. Defaults to `failed` ALONE: the eviction case this exists for
 *     is a legacy transient failure, and a default that could reach a
 *     completed cell is the wrong default for a delete.
 *   @param {boolean}  [opts.allowCompleted=false] permit evicting a completed
 *     cell. Off by default; lib/store.mjs's remove() refuses independently.
 *   @param {number|null} [opts.keepAttempts=DEFAULT_ATTEMPT_RETENTION] how
 *     many attempt records per (cell, family) survive un-folded. `null`
 *     disables compaction entirely.
 *   @param {number|null} [opts.keepBatchReplays=DEFAULT_BATCH_REPLAY_RETENTION]
 *     how many `batch-replay` records per cell survive the supersede
 *     operation (issue #117). Its own knob, deliberately not shared with
 *     `keepAttempts` -- see DEFAULT_BATCH_REPLAY_RETENTION's own header.
 *     `null` disables the supersede operation entirely.
 * @returns {{evictions: Array, refused: Array, compactions: Array,
 *   supersedes: Array, keysBefore: number, keysAfter: number,
 *   selectorsGiven: boolean}}
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
    keepBatchReplays = DEFAULT_BATCH_REPLAY_RETENTION,
  } = opts;

  const selectorsGiven = Boolean(configHash || armIds || briefIds || kinds || states);
  const wantStates = states || ["failed"];
  // The DEFAULT kind filter is the store-absent sets — exactly the failures
  // #90 and #88 would have kept out of the store in the first place. It is a
  // default and not merely a convenience, for the same reason `completed` is
  // protected: an INTRINSIC failure (`parse_failure`, `empty_pool`,
  // `refusal`) is a real, paid-for observation about the arm, and IC-08's
  // silent mode (`empty_pool`) is one of the behaviours the study exists to
  // measure. `--prune --cfg <hash> --apply` is the most natural "repair my
  // legacy store" invocation there is; without this default it would evict
  // every intrinsic failure under that hash, and the arm's real failure rate
  // would be re-rolled toward zero on the next run — precisely the silent
  // bias lib/accounting.mjs's own header warns about. Reaching one requires
  // typing `--kinds intrinsic` (or the literal kind), which is the explicit
  // act the salvage cannot substitute for: the spend survives an eviction,
  // the OBSERVATION does not.
  const kindFilter = kinds || [...TRANSIENT_FAILURE_KINDS, ...PAYMENT_FAILURE_KINDS];
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

      let body = store.get(entry.key);
      if (entry.state === "failed") {
        if (!kindFilter.includes(body.accounting && body.accounting.kind)) continue;
      } else if (kinds) {
        // An explicit kind filter cannot match a record that carries no
        // failure kind at all (a `completed` cell). Excluded rather than
        // waved through: someone who asked for `--kinds rate_limited` did
        // not ask for a completed cell.
        continue;
      }

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
      // Compaction is scoped to ATTEMPT_FAMILIES, not to "every family that
      // uses the attempt-key grammar" (issue #103). `batch-replay` shares the
      // grammar -- and therefore parseAttemptKey and nextAttemptNumber's max+1
      // discipline -- but its body is a batch handle and a set of recovered
      // replies, not cost rows. Compaction rewrites a record's body as the SUM
      // OF ITS COST ROWS and nothing else, so folding one would destroy
      // precisely the handle resume exists to re-poll: the feature would
      // degrade, silently, into a slower way to pay twice.
      if (!ATTEMPT_FAMILIES.includes(parsed.family)) continue;
      const gk = `${parsed.family} ${parsed.cellKey}`;
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
      // Only populated for PRUNED_CELL_FAMILY -- see this loop's push() below
      // and salvageEvictedCellSpend's own header. A raw pruned-cell record
      // carries a single `prunedFromStoredAt` (the physical cell record it
      // salvaged); the topmost compacted record it may be folding already
      // carries the WHOLE set from its own prior fold. Either way, gathering
      // over `contributors` (never the wider `foldSet`) is correct for the
      // identical reason it is correct for `rawRows` above: anything folded
      // out of `foldSet` but not a contributor is already subsumed by
      // `topCompacted`'s own recorded set.
      const prunedFromStoredAts = family === PRUNED_CELL_FAMILY ? new Set() : null;
      let cfg;
      for (const r of contributors) {
        const body = store.get(r.key);
        if (Array.isArray(body.costRows)) rawRows.push(...body.costRows);
        for (const m of Object.values(body.resolvedModels || {})) {
          if (typeof m === "string") models.add(m);
          else if (Array.isArray(m)) for (const x of m) models.add(x);
        }
        if (prunedFromStoredAts) {
          const result = body.result || {};
          if (r.compacted) {
            for (const s of result.prunedFromStoredAts || []) prunedFromStoredAts.add(s);
          } else if (result.prunedFromStoredAt) {
            prunedFromStoredAts.add(result.prunedFromStoredAt);
          }
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
        ...(prunedFromStoredAts ? { prunedFromStoredAts: [...prunedFromStoredAts].sort() } : {}),
      });
    }
  }

  // ── Supersede: drop batch-replay records shadowed by a newer one (#117) ──
  // No fold here (contrast compaction above): a batch-replay record's
  // payload is a durable batch handle plus recovered replies, not cost
  // rows, so there is nothing to sum. The operation is pure removal of
  // every record but the highest-attempt one per cell -- safe outright
  // because BATCH_RESUME_FAMILY records always carry costRows: [] (enforced
  // by writeBatchResumeRecord), so nothing here can ever drop money.
  //
  // Deliberately blind to whether the cell that owns each group has
  // COMPLETED (a `retired` batch-replay record, or one whose cell is stored
  // `completed`, can never replay again and so is dead weight even at
  // `keepBatchReplays`). That is a real decision, not an oversight: reading
  // cross-family cell state here would make this operation's correctness
  // depend on two record families staying in sync, which is exactly the
  // coupling that produced #115's `salvageEvictedCellSpend` bug. Retaining
  // one dead record per still-`keepBatchReplays`-eligible cell is a bounded,
  // honest cost; this prune does not chase it further. See
  // docs/resuming-batches.md for the same call stated for an operator.
  const supersedes = [];
  if (keepBatchReplays !== null && keepBatchReplays !== undefined) {
    if (!Number.isInteger(keepBatchReplays) || keepBatchReplays < 1) {
      throw new Error(`planPrune: keepBatchReplays must be a positive integer (or null to disable), got ${keepBatchReplays}`);
    }
    const byCell = new Map();
    for (const entry of entries) {
      const parsed = parseAttemptKey(entry.key);
      if (!parsed || parsed.family !== BATCH_RESUME_FAMILY) continue;
      if (!byCell.has(parsed.cellKey)) byCell.set(parsed.cellKey, []);
      byCell.get(parsed.cellKey).push({ ...parsed, key: entry.key });
    }
    for (const [cellKeyStr, records] of byCell) {
      if (records.length <= keepBatchReplays) continue;
      // Numeric ordering, never lexical: `through` is already a Number (see
      // parseAttemptKey), so attempt=10 correctly outranks attempt=9 -- a
      // string comparator would get this backwards.
      records.sort((a, b) => a.through - b.through);
      const removeKeys = records.slice(0, records.length - keepBatchReplays).map((r) => r.key);
      const keptKeys = records.slice(records.length - keepBatchReplays).map((r) => r.key);
      supersedes.push({ cellKey: cellKeyStr, removeKeys, keptKeys });
    }
  }

  const netRemoved =
    evictions.length +
    compactions.reduce((n, c) => n + c.removeKeys.length - (store.has(c.newKey) ? 0 : 1), 0) +
    supersedes.reduce((n, s) => n + s.removeKeys.length, 0);
  return {
    evictions,
    refused,
    compactions,
    supersedes,
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
 * ── Known limitation, carried forward rather than fixed here (issue #115) ──
 * The guard throw above fires AFTER every eviction/compaction/supersede in
 * the plan has already been applied to `store` — `ResultsStore` has no
 * transaction, so there is no atomic "apply the whole plan or none of it"
 * available to reach for. #115 considered and deliberately did not attempt
 * this: it is a `lib/store.mjs`-level capability (e.g. a snapshot-and-revert
 * around `remove()`/`put()`), not a fix expressible in this module's policy
 * layer, and the money-first ordering above already makes the one thing that
 * matters true regardless — a crash or a guard throw here over-reports
 * (the same money briefly counted twice) and never under-reports, and a
 * re-run converges (see planPrune's `covered` rule and
 * `salvageEvictedCellSpend`'s idempotency check). The thrown error message
 * says so explicitly ("the store has already been modified") for the same
 * reason this comment does: the limitation is meant to be found here, not
 * rediscovered from a half-mutated store three weeks from now.
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
      result: {
        kind: `${c.family}-compacted`,
        cellKey: c.cellKey,
        through: c.through,
        // Only present for PRUNED_CELL_FAMILY (issue #115): the set of
        // physical cell-record identities (`prunedFromStoredAt`) this fold
        // accounts for. This is what lets salvageEvictedCellSpend's
        // idempotency check keep working once a raw record's OWN identity
        // field has been folded away -- see planPrune's compaction loop,
        // which builds this set, and lib/store.mjs's ATTEMPT_FAMILIES
        // comment for the fuller why.
        ...(c.prunedFromStoredAts ? { prunedFromStoredAts: c.prunedFromStoredAts } : {}),
      },
      resolvedModels: { models: c.models },
      // The compacted record reports the state of what it folds, rather than
      // one hardcoded state for every family. A generation/metrics attempt
      // record is a FAILED attempt by construction (that is why it exists
      // apart from its cell); a `judge-call` record is a SUCCESSFUL, billed
      // judge call stored `completed`. Writing the fold of a pile of
      // completed judge calls as `failed/harness_error` would put a fiction
      // in the ledger, and would also mean a re-compaction of an
      // already-compacted judge record needed a different removal guard than
      // the first one did.
      accounting:
        c.family === "judge-call"
          ? { state: "completed" }
          : {
              state: "failed",
              kind: "harness_error",
              detail: `compacted ${c.family} records for cell '${c.cellKey}' through attempt ${c.through} (issue #98 retention)`,
            },
      costRows: c.rows,
    });
    written.push(c.newKey);
    // `allowCompleted` on the COMPACTION path only, and it is not a loosening
    // of lib/store.mjs's guard so much as a statement about what these keys
    // can be. The guard protects paid-for MEASUREMENTS from a silent delete.
    // `c.removeKeys` comes from parseAttemptKey, which matches only
    // attempt-family keys -- a study cell key (`arm=…|brief=…|rep=…|cfg=…`)
    // is structurally unmatchable here, so no measurement can be in this
    // list. What IS in it, as of #108, are `judge-call` records, which
    // meterJudgeCall stores `completed` because the call succeeded; they
    // carry a cost row and nothing else (the judge's actual scores live in a
    // separate `judge-scores` family, and no analysis module reads a
    // judge-call body). And unlike an eviction, a compaction does not remove
    // money: the fold is priced both ways before it is written, and
    // spendToDate() is re-verified below and throws on any drift.
    // Requiring the operator to type `--allow-completed` -- the flag whose
    // whole meaning is "yes, delete a paid-for measurement" -- to perform an
    // operation that deletes no measurement would train them to pass it.
    store.remove(c.removeKeys, { allowCompleted: true });
    removed.push(...c.removeKeys);
    log(`[prune] compacted ${c.removeKeys.length} ${c.family} record(s) for '${c.cellKey}' into ${c.newKey} (${c.rowsBefore} -> ${c.rows.length} cost row(s))`);
  }

  // ── 3. Remove superseded batch-replay records (issue #117) ──────────────
  // No salvage step, unlike eviction above: BATCH_RESUME_FAMILY records
  // always carry costRows: [] (enforced by writeBatchResumeRecord), so
  // there is no money to re-home before removing them.
  for (const s of plan.supersedes) {
    store.remove(s.removeKeys);
    removed.push(...s.removeKeys);
    log(`[prune] superseded ${s.removeKeys.length} batch-replay record(s) for cell '${s.cellKey}' (kept ${s.keptKeys.length} newest)`);
  }

  // ── 4. Prove the money survived ─────────────────────────────────────────
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
 * Re-home an evicted cell's cost rows under a `pruned-cell|cell=…|attempt=N`
 * record, so the money the cell paid for survives the cell.
 *
 * This is #90's own mechanism applied retroactively: a transient generation
 * failure written before #90 lives under `cell.key`, where it is permanently
 * `reuse`; after this it lives under an attempt-scoped key exactly as #90
 * would have written it, and the cell plans `todo` again.
 *
 * ── Slot allocation: max+1, not scan-from-zero (issue #115) ────────────────
 * `pruned-cell` is one of `ATTEMPT_FAMILIES` (lib/store.mjs), so its records
 * are bounded by the same compaction as every other family here — and that
 * makes a scan-from-zero-for-the-first-FREE-slot allocator actively wrong:
 * a fold frees the low slots it just compacted away, and the very next
 * salvage would reuse one of them, writing NEW real money under a slot
 * number the next compaction's `through` sort places BELOW the already-
 * compacted record — excluding it from `contributors` while `removeKeys`
 * still removes it. That is a silent, permanent spend loss (see this
 * function's own regression test in evals/harness/prune.test.mjs for the
 * exact fold → evict → fold sequence). `nextAttemptNumber` is immune: it
 * derives from the MAXIMUM attempt/through any stored record (raw or
 * compacted) accounts for, so a freed low slot never gets reused.
 *
 * ── Idempotency: identity that SURVIVES a fold (issue #115) ────────────────
 * The salvage still has to be idempotent across a prune interrupted between
 * the salvage write and the cell removal — same requirement #98 always had.
 * What changed is what "already salvaged" can be checked against: a RAW
 * pruned-cell record's identity is its own `prunedFromStoredAt` field (the
 * index entry's `storedAt` for the physical cell record it salvages — see
 * below for why `storedAt`, never content). A COMPACTED one can no longer
 * carry a single `prunedFromStoredAt`, because it folds several such
 * identities into one record; it carries the whole set instead, under
 * `prunedFromStoredAts` (plural — populated by planPrune's compaction loop,
 * see there). Checking both raw and compacted shapes, rather than moving the
 * fold-preserving burden onto the generic compaction path, keeps every OTHER
 * attempt family's compacted body exactly as it always was.
 *
 * "Physical record" is the load-bearing phrase, and identity is the index
 * entry's `storedAt`, never the body's content. Content cannot tell two
 * cases apart, and they need opposite answers:
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

  // ── Idempotency check FIRST, over every stored pruned-cell record ────────
  // Deliberately not folded into the allocation loop below: allocation only
  // needs to know the NEXT number, but idempotency needs to check EVERY
  // existing record (raw or compacted) for this cell, because the match
  // this physical eviction is looking for could be sitting under any slot,
  // including one a fold already renumbered away.
  for (const key of store.keys()) {
    const parsed = parseAttemptKey(key);
    if (!parsed || parsed.family !== PRUNED_CELL_FAMILY || parsed.cellKey !== evicted.key) continue;
    const stored = store.get(key);
    const result = stored.result || {};
    const alreadyCovered = parsed.compacted
      ? (result.prunedFromStoredAts || []).includes(evicted.storedAt)
      : result.prunedFromStoredAt === evicted.storedAt;
    if (alreadyCovered) {
      // Already salvaged (raw) or already folded into a compacted record
      // that accounts for it (compacted) by an interrupted earlier prune.
      // The caller needs to know, because removing the cell now takes away
      // a DUPLICATE of money that is already recorded, not money.
      return { key, reused: true };
    }
  }

  // ── Allocate: max+1 across raw AND compacted shapes ──────────────────────
  // See this function's own header for why scan-from-zero is unsafe once
  // this family compacts.
  const attempt = nextAttemptNumber(store, PRUNED_CELL_FAMILY, evicted.key);
  const key = `${PRUNED_CELL_FAMILY}|cell=${evicted.key}|attempt=${attempt}`;
  store.put({ key, ...body });
  return { key, reused: false };
}

/**
 * The realized-agent fields retained on a STORED cell (issue #102 AC2), in a
 * flat, self-describing shape rather than only nested inside whatever `meta`
 * the engine happened to emit. `{}` when the provider reported nothing usable
 * -- "cannot verify", never "nothing failed"; the absence of the fields is what
 * says so, which is why this returns an empty object rather than zeros.
 *
 * Retained on BOTH a completed cell and a stored intrinsic failure, so the
 * question "how many agents actually contributed to this pool?" has an answer
 * on the record either way. It is a DIAGNOSTIC, not the safety mechanism: the
 * cell's own accounting state already tells the truth about an undersized pool
 * (see provider.mjs's rule block on why an unread field cannot be the fix).
 */
function agentCountFields(source) {
  const realized = realizedAgents(source);
  if (!realized) return {};
  return {
    agentsAttempted: realized.attempted,
    agentsFailed: realized.failed,
    agentsRealized: realized.realized,
  };
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
 * ── `{ batch }` is now a FALLBACK, not the primary source (issue #119) ────
 * Before #119, this was the ONE flag `priceRows`/`priceRowsByProvider`
 * applied to EVERY row in the store -- correct only while a whole store held
 * one regime, which #103's resume path (and the documented `--no-batch`
 * fallback) made false in practice. Cost rows now carry their own
 * `pricing_regime` (lib/accounting.mjs's `costRow()`), and `priceRows` reads
 * it per row; `{ batch }` here is consulted ONLY for rows that predate that
 * field.
 *
 * ── The reconciliation, and the one place it stops short ─────────────────
 * `priceRow`'s own default (`false`/"single") IS `lib/price.mjs`'s
 * `LEGACY_PRICING_REGIME_FALLBACK` -- that is the reconciled, canonical
 * value: a legacy row should be priced at the pricier, non-discounted rate,
 * so the fallback can only OVER-state spend, never under-state it (the same
 * "fail loud/over-project" direction `runnerPriceGrid`'s own header commits
 * to). This function's default deliberately STAYS `true` rather than also
 * adopting it, for a concrete, narrow reason: `pruneStore` (this module's
 * prune/compaction region, out of THIS issue's scope -- see its own header)
 * calls `spendToDate(store)` bare at two points and separately computes
 * `priceRows(knownDuplicateRows, DEFAULT_RATE_TABLE, { batch: true })` to
 * verify money survived a prune, comparing all three. Flipping only this
 * function's default to `false` would price the bare `spendToDate()` calls
 * under a DIFFERENT fallback than the hardcoded `{ batch: true }` `duplicates`
 * term they are subtracted against -- for a store of legacy (regime-less)
 * rows, exactly what `pruneStore`'s own fixture stores are, that desyncs the
 * invariant it exists to enforce and throws `spend-to-date changed across
 * the prune`, a false positive with no actual money defect (confirmed: this
 * was the FIRST thing tried, and it reproduces that exact throw in
 * evals/harness/prune.test.mjs). Reconciling that call site is a one-line
 * fix, but it sits inside the region a sibling lane (#115) owns -- so this
 * default stays `true`, documented as a KNOWN, NAMED exception rather than
 * silently left to disagree with `priceRow`'s for no stated reason. Flagged
 * to the #115 lane in this issue's own closing report.
 *
 * `legacyPricingRowCount`/`legacyPricingFallbackRegime` (AC3) surface HOW
 * MANY of the summed rows had no recorded regime and were therefore priced
 * on this stated assumption rather than a fact -- see `formatSpendSummary`
 * in evals/run.mjs, the report surface this is threaded to. This is the
 * actual acceptance criterion, and it holds regardless of which literal
 * value the fallback resolves to.
 *
 * @param {object} store       a lib/store.mjs ResultsStore
 * @param {object} [rateTable=DEFAULT_RATE_TABLE]  pinned, dated rate table
 * @param {{batch?: boolean}} [opts]  legacy-row fallback (see above) --
 *   NOT the store-wide lever it used to be; a row carrying its own
 *   `pricing_regime` ignores this entirely. Default `true`/"batch" -- see
 *   "the one place it stops short" above for why this diverges from
 *   `priceRow`'s own `LEGACY_PRICING_REGIME_FALLBACK` default.
 * @returns {{ totalUsd: number, byProvider: Object<string, number>,
 *   hasMissingRate: boolean, missingRateModels: string[],
 *   excludedNonProviderUsd: number, excludedNonProviderModels: string[],
 *   legacyPricingRowCount: number, legacyPricingFallbackRegime: string }}
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
    // issue #119 AC3: how many rows had no recorded pricing_regime and were
    // priced on `legacyPricingFallbackRegime` (a stated assumption) instead
    // of a fact. `totals` (priceRows) already computed this scanning the
    // exact same `allCostRows` priceRowsByProvider also scanned, so it is
    // not recomputed here.
    legacyPricingRowCount: totals.legacyPricingRowCount,
    legacyPricingFallbackRegime: totals.legacyPricingFallbackRegime,
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
    // Issue #103: re-poll a batch this study already paid for, and replay its
    // replies, instead of submitting a fresh one. Default true for the same
    // reason `batch` is -- paying twice for the same replies is never the
    // behaviour anyone wants, so it should not need a flag to avoid.
    resume = true,
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

  // Resume is batch-only by construction (see loadBatchResumeState): a
  // single-mode invocation produces no batch handle to re-poll, and replaying
  // batch-produced replies into one would price them at the wrong rate.
  const pricingLever = pricingLeverFor(batch);
  const resumeEnabled = !!resume && !!batch;

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
        // pricing_regime is always "single" here (issue #119), NEVER the
        // generation-side `pricingLever` in scope in this module -- the
        // Voyage embedder in this codebase (lib/embedder.mjs's real
        // implementation and the one wired here) has no async
        // submit-then-poll Batch API code path; `.embed()` is one
        // synchronous HTTP call every time, regardless of whether the
        // STUDY's generation calls ran `--batch` or `--no-batch` this
        // invocation. Stamping the generation-side lever here would record
        // a fact about a DIFFERENT call.
        costRows.push(costRow({ cellKey: cell.key, timestamp, billing_mode: "api", pricing_regime: "single", model: embedder.modelId, input_tokens: delta }));
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
    const { results, deferred, costRows, paymentSkipped } = await runJudgeMatrix({
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
    //
    // paymentSkippedLegs (issue #112): a leg the judge account short-circuited
    // because that provider had ALREADY refused on billing appears in BOTH
    // `results` (as a `failed`/`payment_required` row carrying
    // `attempted: false`) and `paymentSkipped`. It is a SKIP, not a fail --
    // it never made a call, so it did not fail on its own merits, and rolling
    // it into the failure count inflates that count with legs that were never
    // attempted (the same misreporting #88 fixed on the generation side).
    //
    // This is the one part of the change that is NOT purely additive:
    // reconciliation is a one-terminal-state-per-leg gate, so the leg must be
    // excluded from the `results` loop below or `skip()` lands on an
    // already-terminal leg and throws. Deriving the exclusion set from
    // `paymentSkipped` itself -- rather than testing `r.attempted === false`
    // -- makes the partition true BY CONSTRUCTION: exactly the legs skipped
    // here are the legs excluded there, with no dependence on two separately
    // maintained signals in score.mjs staying in sync. Iterating the Set (not
    // the array) dedupes for free, so a duplicated entry cannot double-skip.
    const paymentSkippedLegs = new Map();
    for (const p of paymentSkipped || []) {
      if (alreadyJudged.has(p.judge_provider)) continue;
      paymentSkippedLegs.set(judgeLegKey(p.poolKey, p.judge_provider), p.reason);
    }
    for (const r of results) {
      if (alreadyJudged.has(r.judge_provider)) continue;
      const legKey = judgeLegKey(r.poolKey, r.judge_provider);
      if (paymentSkippedLegs.has(legKey)) continue; // terminal below, as a skip
      if (r.state === "completed") judgeAccount.complete(legKey, { scores: r.scores });
      else judgeAccount.fail(legKey, r.failureKind, r.detail || "");
    }
    // The reason is already colon-prefixed `payment_required: ` by
    // runJudgeMatrix, so reconcile()'s prefix collapse (lib/accounting.mjs)
    // groups every one of these under a single `payment_required` category in
    // `summary.judge.skippedByReason` -- distinct from
    // `summary.judge.byKind.payment_required`, which now counts ONLY the legs
    // that actually called and were actually refused.
    for (const [legKey, reason] of paymentSkippedLegs) {
      judgeAccount.skip(legKey, reason);
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
    // ── Batch resume (issue #103) ──────────────────────────────────────
    // Hand the provider whatever this cell has already paid for. All store
    // I/O stays HERE: the provider is handed a plain state object and hands
    // one back, exactly as it does for tokens and diagnostics, so nothing in
    // provider.mjs needs to know what a ResultsStore is.
    const resumeState = resumeEnabled ? loadBatchResumeState(store, cell, pricingLever, log) : null;
    let response;
    try {
      response = await provider.generate(cell, arm, { mode: batch ? "batch" : "single", timestamp, resume: resumeState });
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

    // The rule: persist the replay state for any cell that will be RE-PLANNED,
    // and for no cell that will be stored `completed`.
    //
    // A stored `completed` cell is classified `reuse` by `planRun` forever
    // after, so it can never re-enter this loop and has nothing to replay --
    // writing a record for it would be pure bloat on the happy path, and
    // these records carry full reply text. Everything else is re-planned
    // `todo` per #90, and every one of those is a cell that would otherwise
    // pay a second time for replies the provider already produced.
    //
    // That is two call sites, not one, and deliberately so: the second is the
    // undersized-pool backstop below, which is the one case where generation
    // COMPLETED (and was paid for) but the cell is discarded anyway. It is
    // called out there rather than folded in here because "completed" and
    // "stored" are not the same predicate, and collapsing them is exactly the
    // mistake that would silently re-spend that cell's generation.
    if (resumeEnabled && response.terminalState !== "completed") {
      persistBatchResumeState(store, cell, response.resume, pricingLever, log);
    }

    if (response.terminalState === "completed") {
      const genCostRows = costRowsFor(cell.key, response.tokens, timestamp, pricingLever);

      // ── UNDERSIZED-POOL BACKSTOP (issue #102) ────────────────────────────
      // A cell whose pool was assembled from fewer agents than its arm
      // specifies must not be stored `completed`. The full rule -- what it is,
      // the two alternatives rejected, and why the shortfall test is
      // `meta.agentsFailed > 0` rather than a comparison against
      // `arm.slots.length` -- lives in provider.mjs above `classifyUndersizedPool`.
      // It is stated ONCE, there, because that is where the evidence to
      // classify the CAUSE lives (transport signals, per-reply diagnostics).
      //
      // This is the provider-agnostic BACKSTOP, not the primary enforcement:
      // both shipped providers already refuse to return `completed` for a
      // short pool, so in practice this branch is unreachable through them.
      // It exists so the rule is a property of the harness rather than of two
      // adapters -- a third provider, or a regression in one of the two, is
      // caught here instead of quietly writing a biased cell.
      //
      // LIMITATION, stated rather than papered over: this can only check a
      // provider that REPORTS its realized agent counts. `realizedAgents`
      // returns null for a response carrying no usable `meta` (MockProvider,
      // and any future adapter that omits it), and this branch then passes the
      // cell through. "Cannot verify" is not "verified fine" -- the guarantee
      // for such a provider rests entirely on the provider itself.
      //
      // Placed BEFORE computeCellMetrics deliberately: embedding a pool we
      // have already decided to discard would spend real Voyage tokens on a
      // cell that is never stored -- the same waste #92's #completeBatched
      // short-circuit exists to prevent one layer down.
      const realized = realizedAgents(response.result);
      if (realized && realized.failed > 0) {
        const detail =
          `runSpec: provider returned a COMPLETED response for cell '${cell.key}' whose pool was assembled from ` +
          `fewer agents than arm '${cell.armId}' specifies -- agents_attempted=${realized.attempted} ` +
          `agents_failed=${realized.failed} agents_realized=${realized.realized}. Storing it would silently ` +
          `under-report this cell's pool size (issue #102). A provider must classify this itself; this is the ` +
          `harness backstop.`;
        // harness_error, and the choice is not incidental: the runner cannot
        // see WHY those agents dropped out (that evidence is the provider's
        // diagnostics), so it must not assert an intrinsic cause it has no
        // basis for. harness_error is transient, so #90 keeps cell.key out of
        // the store and the next invocation re-plans this cell -- and it names
        // the right culprit, which is a provider not honouring the contract.
        account.fail(cell.key, "harness_error", detail);
        for (const row of genCostRows) account.addCost(row);
        // Money-first, exactly as the transient branch below: the generation
        // call already succeeded and already spent real money. Nothing goes
        // under cell.key (so planRun re-plans it); the spend goes under an
        // attempt-scoped key so it is never lost.
        notStoredTransientByKind.harness_error = (notStoredTransientByKind.harness_error || 0) + 1;
        recordGenerationAttemptFailure(store, {
          cell,
          costRows: genCostRows,
          kind: "harness_error",
          detail,
          resolvedModels: resolvedModelsFor(arm),
        });
        // The second of the two resume call sites (#103) -- see the first,
        // just after provider.generate(). Generation COMPLETED and was paid
        // for, and this cell is still being re-planned, so its replies must
        // survive or the next invocation buys them again.
        if (resumeEnabled) persistBatchResumeState(store, cell, response.resume, pricingLever, log);
        recordActualSpend(genCostRows);
        continue; // no metrics, no store.put, no judging -- this pool is discarded
      }

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

      // agentCountFields (issue #102 AC2): the realized agent count is retained
      // on the stored cell in a flat, self-describing shape -- `{}` (no fields
      // at all) when the provider reported nothing usable, so "we could not
      // verify" never reads as "nothing failed". By construction every cell
      // reaching here has agentsFailed === 0 or unverifiable counts; the fields
      // are retained anyway so a reader can tell those two apart on the record
      // rather than by knowing which provider ran.
      const finalResult = {
        ...(metrics ? { ...response.result, ...metrics.resultPatch } : response.result),
        ...agentCountFields(response.result),
      };
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
      const costRows = costRowsFor(cell.key, response.tokens, timestamp, pricingLever);
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
          // agentCountFields (issue #102 AC2): a stored INTRINSIC failure is
          // the one failure that becomes a permanent record of the arm, and a
          // partial refusal / partial parse_failure now lands here (it used to
          // complete with an undersized pool). Retaining the counts is what
          // lets a reader of the store tell "every agent refused" from "two of
          // five refused and we discarded the other three's ideas" -- read off
          // the provider response's own `meta`, which the undersized-pool
          // branches carry for exactly this purpose.
          result: { failed: true, failureKind: response.failureKind, ...agentCountFields(response) },
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
  // judgePaymentAbort (issue #112): the judge-side analogue of
  // `summary.paymentAbort` below, and the surface that makes the two
  // billing outcomes legible SEPARATELY rather than leaving a reader to
  // notice that one number lives in `byKind` and the other in
  // `skippedByReason`. The distinction is operationally real:
  //
  //   refused -- legs that made a call and the account said no. Real
  //              attempts; may have consumed tokens (a refused call that
  //              burned input tokens still writes its cost row).
  //   skipped -- legs never attempted, because the SAME provider had already
  //              refused and every later leg on it would hit the identical
  //              wall. Nothing called, nothing spent, nothing stored.
  //
  // Before #112 both landed in `byKind.payment_required` as failures, so the
  // count could not say how it split -- which inflates the judge-side failure
  // count with legs that never made a call. `null` means no judge-side
  // billing refusal occurred this invocation, never "we did not check"; it is
  // also `null` when judging was disabled, matching `summary.judge`.
  const judgeRefused = (summary.judge && summary.judge.byKind && summary.judge.byKind.payment_required) || 0;
  const judgeUnattempted =
    (summary.judge && summary.judge.skippedByReason && summary.judge.skippedByReason.payment_required) || 0;
  summary.judgePaymentAbort = judgeRefused || judgeUnattempted ? { refused: judgeRefused, skipped: judgeUnattempted } : null;
  if (summary.judgePaymentAbort) {
    // #106 first put a notice for this condition in evals/run.mjs, before
    // this summary knew the refused/skipped split -- it could only say the
    // abort was "entirely billing", not how it divided. #116 deleted that
    // duplicate (it fired on the same condition as this one, so a real
    // judge-side billing refusal printed `[run] JUDGING ABORTED:` twice) and
    // folded its two operator-actionable clauses that this notice lacked --
    // the docs/retrying-failed-cells.md pointer and the spend-preserved
    // sentence -- into the text below, so nothing #106 added is lost.
    log(
      `[run] JUDGING ABORTED: a judge account refused on billing/credit. ${judgeRefused} judge leg(s) were ` +
        `actually attempted and refused; a further ${judgeUnattempted} leg(s) were NOT attempted, because every ` +
        `later leg on that same account would have hit the identical wall. Nothing was called or spent for the ` +
        `unattempted ones. GENERATION was NOT stopped: those pools are stored, and the next invocation of the ` +
        `same command judges them once the account is funded. Judge legs on any OTHER provider are unaffected. ` +
        `Spend already incurred is preserved; see docs/retrying-failed-cells.md.`,
    );
  }
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
    // issue #119 AC3: how many of the store's cost rows predate
    // `pricing_regime` and were therefore priced under
    // `priorSpend.legacyPricingFallbackRegime` (a stated assumption) rather
    // than a fact recorded on the row -- surfaced alongside the cumulative
    // total it partly rests on, per `spendToDate`'s own header. This
    // invocation's OWN newly-written rows always carry the field (see
    // `costRowsFor`), so this count only ever reflects rows from BEFORE this
    // issue shipped, or a caller that deliberately omitted it.
    summary.cumulativeLegacyPricingRowCount = priorSpend.legacyPricingRowCount;
    summary.cumulativeLegacyPricingFallbackRegime = priorSpend.legacyPricingFallbackRegime;
  } else {
    summary.cumulativeSpendByProvider = null;
    summary.cumulativeNonProviderSpendUsd = null;
    summary.cumulativeNonProviderModels = null;
    summary.cumulativeSpendUsd = null;
    summary.cumulativeLegacyPricingRowCount = null;
    summary.cumulativeLegacyPricingFallbackRegime = null;
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
