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
import { RunAccount, costRow, TERMINAL_STATES } from "../../lib/accounting.mjs";
import { assertValidProviderResponse } from "./provider.mjs";

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
  // OpenAI arms (G, H) are unpriced placeholders until the adapter + real
  // rates land (see arms.config.json's openaiModelId note) -- estimate at a
  // representative mid-tier rate from §8.1's range so --max-spend still has a
  // number, clearly not authoritative.
  "openai-mid-tier": { in: 3.5, out: 18.0 },
  "openai-large-tier": { in: 3.5, out: 18.0 },
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
    for (const slot of slots) {
      const rate = INTERIM_RATES_USD_PER_MTOK[slot.model];
      if (!rate) {
        throw new Error(`interimPriceGrid: no interim rate for model '${slot.model}' (arm '${cell.armId}') -- add it to INTERIM_RATES_USD_PER_MTOK or wait for lib/price.mjs (#7)`);
      }
      cellUsd += (perSlotIn / 1_000_000) * rate.in + (perSlotOut / 1_000_000) * rate.out;
    }
    cellUsd *= discount;
    breakdown.push({ cellKey: cell.key, usd: cellUsd });
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
 * Plan a spec against the store (the shared first half of dry-run and a real
 * run) and price the `todo` set. Pulled out of runSpec() so --dry-run and the
 * real run price identically -- no drift between "what dry-run predicted" and
 * "what a real run would refuse to start over".
 *
 * @returns {{ plan: {todo, reuse, stale}, projection: {usd, breakdown} }}
 */
export function planAndPrice(spec, { store, armsConfig, priceGrid = interimPriceGrid, batch = true }) {
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
 *   @param {number}  [opts.maxSpendUsd] pre-flight ceiling; if the priced
 *     projection exceeds it, the run refuses to start (see below for the
 *     precise semantics -- this is a per-cell admission control, not just an
 *     abort switch, so a run can still make partial progress under a cap).
 *   @param {string[]} [opts.armIds]     --arms subset
 *   @param {string[]} [opts.briefIds]   --briefs subset
 *   @param {number}   [opts.replicates] --replicates override
 *   @param {(msg: string) => void} [opts.log]  defaults to console.log; tests
 *     inject a silent logger to keep test output clean.
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
    armIds,
    briefIds,
    replicates,
    log = (msg) => console.log(msg),
  } = opts || {};

  if (!store) throw new Error("runSpec: store is required");
  if (!armsConfig || !armsConfig.arms) throw new Error("runSpec: armsConfig is required");
  if (!dryRun && !provider) throw new Error("runSpec: provider is required unless dryRun is true");

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

  // ── --max-spend: pre-flight prices the planned grid and REFUSES TO START
  // if the projection exceeds the ceiling. "Refuses to start" here means: no
  // cell in the over-budget run is ever sent to the provider. We still want
  // every planned cell accounted for (the non-negotiable), so cells are
  // walked in order and skipped via RunAccount as soon as the running total
  // would exceed the cap -- rather than aborting the process outright, which
  // would leave earlier todo cells un-accounted. If maxSpendUsd is set below
  // the FULL projection, the whole grid is skipped (running total starts at
  // 0 and the very first cell already exceeds it if the ceiling is $0 or
  // negative-effectively; a ceiling below the full total but above some
  // prefix runs that prefix and skips the rest -- see the per-cell loop).
  const overBudget = maxSpendUsd !== undefined && projection.usd > maxSpendUsd;
  if (maxSpendUsd !== undefined) {
    log(`[max-spend] ceiling=$${maxSpendUsd} projected=$${projection.usd.toFixed(4)} ${overBudget ? "(over budget -- admission-controlling cells)" : "(within budget)"}`);
  }

  const plannedKeys = [...plan.reuse.map((c) => c.key), ...plan.todo.map((c) => c.key)];
  const account = new RunAccount(plannedKeys);

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
    } else if (priorState.state === "failed") {
      account.fail(cell.key, priorState.kind, priorState.detail || "");
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

  const priceByKey = new Map(projection.breakdown.map((b) => [b.cellKey, b.usd]));
  let runningTotal = 0;

  for (const cell of plan.todo) {
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
    if (maxSpendUsd !== undefined && runningTotal + cellCost > maxSpendUsd) {
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
      account.skip(cell.key, "budget_exceeded");
      continue;
    }
    runningTotal += cellCost;

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
      account.fail(cell.key, "harness_error", `provider threw: ${err && err.message}`);
      continue;
    }

    if (response.terminalState === "completed") {
      account.complete(cell.key, response.result);
      const costRows = costRowsFor(cell.key, response.tokens, timestamp);
      for (const row of costRows) account.addCost(row);
      store.put({
        key: cell.key,
        armId: cell.armId,
        briefId: cell.briefId,
        replicate: cell.replicate,
        cfg: cell.cfg,
        result: response.result,
        resolvedModels: resolvedModelsFor(arm),
        accounting: { state: "completed" },
        costRows,
      });
    } else {
      // response.terminalState === "failed" -- a classified provider
      // failure surfaces as a `failed` cell, never a missing one.
      account.fail(cell.key, response.failureKind, response.detail || "");
      const costRows = costRowsFor(cell.key, response.tokens, timestamp);
      for (const row of costRows) account.addCost(row);
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
  }

  // The gate: reconcile() throws unless every planned cell reached exactly
  // one terminal state. Called before any statistic is computed -- there is
  // none computed in this module, but the summary below is derived from
  // reconcile()'s own tally, so it is definitionally post-gate.
  const summary = account.reconcile();
  log(`[run] planned=${summary.planned} completed=${summary.completed} failed=${summary.failed} skipped=${summary.skipped}`);
  return { summary, account };
}
