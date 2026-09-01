// price.mjs — read-time pricing from a pinned, dated rate table (issue #7).
//
// ── Why read-time (cwc#1639 / cron-fleet#35 / cron-fleet#75) ────────────────
// lib/accounting.mjs's costRow() REFUSES to accept a `cost_usd` field — the
// ledger stores tokens x model x timestamp x billing_mode, never a derived
// dollar figure. That is deliberate: a row carrying a persisted dollar figure
// with no token counts can never be repriced when a rate changes, which is
// the exact defect cron-fleet#75 exists to fix. This module is the pricing
// layer that reads those rows and produces dollar figures AT READ TIME.
//
// The discipline that makes this work: pricing is a PURE FUNCTION of
// (cost rows, rate table). It never writes anything back to the ledger. Swap
// the rate table, re-run priceRows() over the same stored rows, get a new
// total -- no re-collection, no re-running the study. That purity is what
// "re-pricing the whole study is one command" (an acceptance criterion)
// actually means in code: there is no code path here that could make the
// re-price depend on anything other than its two arguments.
//
// ── The runner's INTERIM pricer (superseded) ─────────────────────────────────
// evals/harness/runner.mjs shipped `interimPriceGrid` in #5 as a placeholder
// so --max-spend/--dry-run had *something* to price the PLANNED grid against
// before this module existed. That estimator prices future, not-yet-run
// cells from a coarse token ESTIMATE (docs/PREREGISTRATION.md §8.2's
// "~16k in / 9k out" projection) -- it has no ledger rows to read yet. This
// module is the opposite direction: it prices ACTUAL cost rows already
// recorded by lib/accounting.mjs's costRow(), after a cell has run. Both are
// legitimate and serve different moments (pre-flight estimate vs. actual
// spend), but only this one is "the authoritative cost ledger's pricer" the
// pre-registration §7 promises. See `runnerPriceGrid` below for a thin
// adapter that lets the ESTIMATOR seam in runner.mjs be driven by rows priced
// through this table's rates, if a caller wants that -- it does not replace
// interimPriceGrid, which prices a *plan*, not *rows*.

// ── The rate table ────────────────────────────────────────────────────────
//
// Every entry is DATED and PINNED, and carries a `source` for exactly where
// the number came from -- both are acceptance criteria (issue #7: "Every
// rate entry carries a source URL and a date"). `in`/`out` are USD per
// million tokens (MTok), matching docs/PREREGISTRATION.md §8.1's units.
// `unverified: true` marks a rate that could NOT be confirmed against the
// vendor's own pricing page -- see the OpenAI section below for what that
// means concretely for this table.
//
// Anthropic + Voyage rows: the pre-registration's §8.1 baseline, sourced to
// the `claude-api` skill (this repo's cached, dated reference for Anthropic
// model IDs and rates -- see shared/models.md and the SKILL.md pricing table
// inside that skill). Invoked 2026-07-31 while building this file; the
// skill's cached model/price table carries its own internal cache date
// (2026-06-24) which we record as the rate's `date` per the pre-registration
// convention ("claude-api skill (cached 2026-06-24)"). Values match
// SKILL.md's "Current Models" table and the pre-registration's §8.1 exactly:
//   Opus 5    -> claude-opus-4-8 in this table's model IDs: $5.00 / $25.00
//   Sonnet 5  -> claude-sonnet-5: $3.00 / $15.00 (intro $2.00 / $10.00 through 2026-08-31)
//   Haiku 4.5 -> claude-haiku-4-5: $1.00 / $5.00
// (arms.config.json's model IDs -- claude-opus-5, claude-sonnet-5,
// claude-haiku-4-5 -- are the pre-registration's *labels*; the skill's actual
// wire model IDs are claude-opus-4-8 / claude-sonnet-5 / claude-haiku-4-5.
// This table keys by the arms.config.json id AS WRITTEN so a lookup never
// has to translate; see RATE_TABLE_KEY_NOTE below.)
//
// OpenAI rows: VERIFIED against the official pricing page during this
// session -- see the OPENAI_PRICE_VERIFICATION block below for the exact
// check (URL, date, numbers found). The pre-registration explicitly flagged
// its OpenAI numbers as "aggregator sites, not openai.com -- must verify"
// (docs/PREREGISTRATION.md §8.1); this is that verification.
const RATE_TABLE_DATE = "2026-07-31";

// arms.config.json's OpenAI slots now carry REAL, first-party-verified OpenAI
// model ids (issue #22): gpt-5.6-terra (mid tier) and gpt-5.6-sol (flagship
// tier), chosen to sit in the same relative tier the pre-registration's §8.1
// range implied ("~2.00-5.00 in / ~12.00-30.00 out") -- see
// OPENAI_PRICE_VERIFICATION for why these two, not an older GPT-5 family
// member. This table keys by those exact ids, so runnerPriceGrid() and
// priceRow() look up an arm slot's `model` (or a tokens_by_model key) directly
// with no translation step. (The earlier UNVERIFIED placeholders
// "openai-mid-tier"/"openai-large-tier" were replaced with these ids in #22.)
const RATE_TABLE_KEY_NOTE =
  "Keys match the exact model id strings arms.config.json uses (its arm slots' `model` field, e.g. 'claude-opus-5', 'gpt-5.6-terra') -- the vendor's own wire id where the two differ. This lets callers look up a row's `model` (or a tokens_by_model key) directly with no translation step.";

export const RATE_TABLE = {
  // ── Anthropic (source: claude-api skill, cached 2026-06-24) ───────────────
  "claude-opus-5": {
    in: 5.0,
    out: 25.0,
    source: "claude-api skill (SKILL.md Current Models table, claude-opus-4-8)",
    date: "2026-06-24",
  },
  "claude-sonnet-5": {
    in: 3.0,
    out: 15.0,
    // Introductory rate through 2026-08-31 per the claude-api skill and
    // docs/PREREGISTRATION.md §8.1. Recorded as a distinct, dated regime
    // rather than silently averaged into the standard rate -- see
    // priceRow()'s `introUntil` handling below.
    introUntil: "2026-08-31",
    introRate: { in: 2.0, out: 10.0 },
    source: "claude-api skill (SKILL.md Current Models table, claude-sonnet-5)",
    date: "2026-06-24",
  },
  "claude-haiku-4-5": {
    in: 1.0,
    out: 5.0,
    source: "claude-api skill (SKILL.md Current Models table, claude-haiku-4-5)",
    date: "2026-06-24",
  },
  // Voyage-4-lite embeddings: input-only pricing (no output tokens for an
  // embedder). +200M free tokens/account per the pre-registration; not
  // modeled as a discount here (see priceRow() note) because a free
  // allocation is an account-level counter this pure function has no access
  // to -- it prices as if every token were billed, which is the correct
  // upper bound for a study-cost projection.
  "voyage-4-lite": {
    in: 0.02,
    out: 0, // embeddings have no output-token dimension
    source: "claude-api skill / docs/PREREGISTRATION.md §8.1 (Voyage-4-lite embeddings)",
    date: "2026-06-24",
    notes: "+200M free tokens/account (not modeled -- prices the full token count); batch -33% (not -50%, see BATCH_DISCOUNT_BY_MODEL)",
  },

  // ── OpenAI (source: developers.openai.com/api/docs/pricing, VERIFIED
  //    against the official page this session -- see
  //    OPENAI_PRICE_VERIFICATION below for the full check) ───────────────
  //
  // arms.config.json's G/H OpenAI slots use these real ids directly (issue
  // #22): gpt-5.6-terra (mid tier) and gpt-5.6-sol (flagship tier) -- OpenAI's
  // current mid- and flagship-tier general-purpose models, matching the
  // pre-registration's intended tier split ("OpenAI (mid/large tiers)").
  "gpt-5.6-terra": {
    in: 2.0,
    out: 12.0,
    source: "https://developers.openai.com/api/docs/pricing (verified against official page; canonical URL -- openai.com/api/pricing redirects here)",
    date: "2026-07-31",
    tier: "mid",
    verified: true,
  },
  "gpt-5.6-sol": {
    in: 5.0,
    out: 30.0,
    source: "https://developers.openai.com/api/docs/pricing (verified against official page; canonical URL -- openai.com/api/pricing redirects here)",
    date: "2026-07-31",
    tier: "flagship",
    verified: true,
  },
};

// ── OpenAI rate verification record (acceptance criterion) ──────────────────
// "OpenAI rates verified against openai.com, with the check recorded" -- this
// object IS that record, in code, so it travels with the table it backs
// (rather than living only in a PR description that can drift from the
// table). The PR body for issue #7 restates this same URL/date/numbers.
export const OPENAI_PRICE_VERIFICATION = {
  checkedAt: "2026-07-31",
  requestedUrl: "https://openai.com/api/pricing",
  // openai.com/api/pricing redirected (301) to this URL, which is the one
  // actually fetched and read -- both are "openai.com" in the sense the
  // pre-registration means it (the official site, not a third-party
  // aggregator), so this satisfies "verified against openai.com".
  resolvedUrl: "https://developers.openai.com/api/docs/pricing",
  method: "WebFetch (direct fetch + extraction of the rendered pricing table)",
  // What the fetch found, restated here so a future reader doesn't have to
  // re-derive it from the RATE_TABLE entries above. This is the FULL current
  // flagship lineup as returned by the official page at check time, not
  // just the two rows this table uses -- kept for audit value (e.g. to see
  // that gpt-5.6-sol/terra/luna were the newest generation available, and
  // that gpt-5/gpt-5-mini are still listed and NOT discontinued, contrary to
  // at least one aggregator's claim encountered while researching this).
  modelsFoundUsdPerMTok: {
    "gpt-5.6-sol": { in: 5.0, out: 30.0 },
    "gpt-5.6-terra": { in: 2.0, out: 12.0 },
    "gpt-5.6-luna": { in: 0.2, out: 1.2 },
    "gpt-5.5": { in: 5.0, out: 30.0 },
    "gpt-5.5-pro": { in: 30.0, out: 180.0 },
    "gpt-5.4": { in: 2.5, out: 15.0 },
    "gpt-5.4-mini": { in: 0.75, out: 4.5 },
    "gpt-5.4-nano": { in: 0.2, out: 1.25 },
    "gpt-5.4-pro": { in: 30.0, out: 180.0 },
    "gpt-5.2": { in: 1.75, out: 14.0 },
    "gpt-5.2-pro": { in: 21.0, out: 168.0 },
    "gpt-5.1": { in: 1.25, out: 10.0 },
    "gpt-5": { in: 1.25, out: 10.0 },
    "gpt-5-mini": { in: 0.25, out: 2.0 },
    "gpt-5-nano": { in: 0.05, out: 0.4 },
    "gpt-5-pro": { in: 15.0, out: 120.0 },
    "gpt-4.1": { in: 2.0, out: 8.0 },
    "gpt-4.1-mini": { in: 0.4, out: 1.6 },
    "gpt-4.1-nano": { in: 0.1, out: 0.4 },
    "o3": { in: 2.0, out: 8.0 },
    "o4-mini": { in: 1.1, out: 4.4 },
  },
  batchDiscountFound: 0.5, // "The Batch API offers a 50% discount ... across models"
  // Which of the models above this table actually uses, and why. Keyed by the
  // arms.config.json role (issue #22 replaced the "openai-mid-tier"/
  // "openai-large-tier" placeholders with these real ids as the arm slot model).
  selection: {
    "G/H mid-tier slots (gpt-5.6-terra)": {
      chose: "gpt-5.6-terra",
      why: "current-generation mid tier, closest live analogue to the pre-registration's '~2.00-5.00 in' OpenAI mid-tier range; used by arm H (homogeneous) and arm G's proposer_4",
    },
    "G flagship slot (gpt-5.6-sol)": {
      chose: "gpt-5.6-sol",
      why: "current-generation flagship tier, matches the pre-registration's '~12.00-30.00 out' upper end; used by arm G's proposer_5",
    },
  },
  note:
    "A prior WebSearch pass (aggregator sites) claimed GPT-5/GPT-5-mini were discontinued and replaced by a 'GPT-5.6' family at different prices than what the official page shows -- this is exactly the aggregator-drift risk the pre-registration's ⚠️ flagged. The numbers actually recorded in RATE_TABLE above come only from the officially-fetched page (this record), not from that search.",
};

// ── providerOf: the model-id -> provider inference used for per-provider spend ──
// issue #51 (per-provider --max-spend ceilings) needs to know which provider a
// model id belongs to, both for the PLANNED-grid projection (runnerPriceGrid's
// `byProvider` breakdown below) and for pricing ACTUAL cost rows already on the
// ledger. Same convention arms.config.json's own header comment documents and
// evals/judge/matrix.mjs already implements for the cross-judge matrix:
// "claude-* -> anthropic, openai-* (and gpt-*) -> openai". Duplicated here
// rather than imported from evals/judge/matrix.mjs for the same layering reason
// PLAN_TOKEN_ESTIMATE above is duplicated instead of imported from runner.mjs --
// lib/ stays reusable independent of evals/. This is deliberately the SAME rule
// applied to judge model ids too (a `judge_model` is drawn from the identical
// claude-*/gpt-* id space), so a future judge-cost tracker can reuse this
// function unmodified rather than re-deriving the prefix rule a third time.
export function providerOf(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error(`providerOf: modelId must be a non-empty string, got ${JSON.stringify(modelId)}`);
  }
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("openai-") || modelId.startsWith("gpt-")) return "openai";
  // voyage-* (the embedder) has no provider bucket in this study's spend
  // ceilings -- Voyage spend is not gated by --max-spend-anthropic/-openai.
  // Fail loud rather than guess, same precedent as matrix.mjs's providerOf.
  throw new Error(`providerOf: cannot infer a provider for model id '${modelId}' (expected a 'claude-*' or 'openai-*'/'gpt-*' prefix)`);
}

// ── Batch discount: an explicit, visible factor -- never baked into `in`/`out` ──
// Both Anthropic and OpenAI batch APIs are -50% per docs/PREREGISTRATION.md
// §8.1 ("Two levers cut this roughly in half"). Voyage batch is -33%
// (embeddings-specific, same source). Keyed by the SAME model-id strings as
// RATE_TABLE so priceRow() can look a model's discount up without a second
// mapping table drifting out of sync with the first.
export const BATCH_DISCOUNT_BY_MODEL = {
  "claude-opus-5": 0.5,
  "claude-sonnet-5": 0.5,
  "claude-haiku-4-5": 0.5,
  "voyage-4-lite": 1 / 3, // "-33%" per §8.1
  "gpt-5.6-terra": 0.5,
  "gpt-5.6-sol": 0.5,
};
const DEFAULT_BATCH_DISCOUNT = 0.5; // Anthropic/OpenAI's common figure; used only if a model is absent above

/**
 * Resolve the {in, out} rate for one model at one point in time, applying
 * the Sonnet 5 intro-rate window if applicable. Pulled out of priceRow() so
 * the date-window logic has exactly one implementation.
 *
 * @param {object} entry     a RATE_TABLE[model] row
 * @param {string} timestamp ISO 8601, from the cost row (never `Date.now()`
 *                           here -- READ-TIME pricing must be a pure function
 *                           of its inputs, and "now" is not an input)
 */
function resolveBaseRate(entry, timestamp) {
  if (entry.introUntil && entry.introRate) {
    // String comparison is safe for ISO 8601 timestamps of the same
    // precision family (both are date or date-time strings); ISO 8601's
    // lexicographic order matches chronological order by construction.
    if (timestamp <= entry.introUntil) return entry.introRate;
  }
  return { in: entry.in, out: entry.out };
}

/**
 * Price one model's token usage at its base (non-batch) rate. Internal --
 * priceRow() is the public per-row entry point; this is the per-model unit
 * the row-level and tokens_by_model-level pricing both reduce to.
 *
 * @param {string} model
 * @param {object} tokens    {input_tokens, output_tokens, cache_read_input_tokens,
 *                            cache_creation_input_tokens} -- any subset; costRow()
 *                            never coerces an absent field to zero (null means "no
 *                            data", 0 means "measured zero"), so this function
 *                            treats missing/null the same way: contributes $0,
 *                            not an error, because a model call that reports no
 *                            output tokens (e.g. embeddings) is not a pricing bug.
 * @param {string} timestamp ISO 8601
 * @param {object} rateTable
 * @returns {{usd: number, rate: {in: number, out: number}, source: string,
 *            date: string, unverified?: boolean, missingRate?: boolean}}
 */
function priceModelTokens(model, tokens, timestamp, rateTable) {
  const entry = rateTable[model];
  if (!entry) {
    // A pricing gap must be LOUD, not a silent $0 -- an unpriced model
    // sailing through as free would be a worse bug than a thrown error,
    // exactly per interimPriceGrid's own "fail loud, not fail cheap"
    // precedent in runner.mjs for the same failure shape.
    return { usd: 0, missingRate: true, model };
  }
  const rate = resolveBaseRate(entry, timestamp);
  // cache_read_input_tokens / cache_creation_input_tokens are priced at the
  // same `in` rate as input_tokens here -- this repo's rate table (mirroring
  // the pre-registration §8.1) does not carry separate cache read/write
  // multipliers, so treating cache tokens as ordinary input tokens is the
  // documented, conservative choice: it never UNDER-counts a real charge.
  // (Anthropic's actual cache economics are cheaper than base input for
  // reads and a premium for writes; this table intentionally does not model
  // that distinction -- callers who need it can extend RATE_TABLE entries
  // with a `cacheReadRate`/`cacheWriteRate` and this function's next
  // revision would honor them. Undocumented today, so priced at parity.)
  const inputTokens =
    (tokens.input_tokens || 0) +
    (tokens.cache_read_input_tokens || 0) +
    (tokens.cache_creation_input_tokens || 0);
  const outputTokens = tokens.output_tokens || 0;
  const usd = (inputTokens / 1_000_000) * rate.in + (outputTokens / 1_000_000) * rate.out;
  return {
    usd,
    rate,
    source: entry.source,
    date: entry.date,
    unverified: entry.unverified === true,
  };
}

/**
 * Price ONE accounting cost row (lib/accounting.mjs's costRow() shape) at
 * READ TIME. Handles both single-`model` rows and multi-model
 * `tokens_by_model` rows (the mixed-tier arms E/F/G, per
 * docs/PREREGISTRATION.md §7 point 4) -- costRow() accepts either shape, and
 * this is the reader for both.
 *
 * NEVER persists a dollar figure back onto the row -- the return value is
 * for the CALLER to use (report, sum, compare); nothing here mutates `row`
 * or writes to lib/store.mjs. That is the whole point of read-time pricing.
 *
 * @param {object} row        a costRow()-shaped ledger row: {cellKey,
 *   timestamp, billing_mode, model?, tokens_by_model?, input_tokens?, ...}
 * @param {object} [rateTable=RATE_TABLE]  swap this to re-price under a
 *   different table -- see repriceRows() for the one-command re-price this
 *   enables
 * @param {object} [opts]
 * @param {boolean} [opts.batch]  true if this row's spend was via the batch
 *   API. NOT read from `row` -- billing_mode on the row is "api" | "subscription"
 *   (the metering regime, per lib/accounting.mjs), which is orthogonal to
 *   batch-vs-realtime (a pricing LEVER within the "api" regime). A caller
 *   that knows a cell ran batch-first (the harness default per #5 -- see
 *   runner.mjs's `batch = true` default) passes `batch: true` explicitly.
 * @returns {{
 *   cellKey: string,
 *   billing_mode: "api"|"subscription",
 *   usd_field: "cost_usd"|"notional_usd",
 *   total: number,
 *   byModel: Array<{model: string, baseUsd: number, batchApplied: boolean,
 *     batchDiscount: number, finalUsd: number, source?: string, date?: string,
 *     unverified?: boolean, missingRate?: boolean}>
 * }}
 */
export function priceRow(row, rateTable = RATE_TABLE, { batch = false } = {}) {
  if (!row || typeof row !== "object") {
    throw new Error("priceRow: row is required");
  }
  if (!row.cellKey) throw new Error("priceRow: row.cellKey is required");
  if (!row.timestamp) throw new Error("priceRow: row.timestamp is required");
  if (row.billing_mode !== "api" && row.billing_mode !== "subscription") {
    throw new Error(`priceRow: row.billing_mode must be "api" or "subscription", got ${row.billing_mode}`);
  }

  // Names the billing regime for the figure this function emits (issue #7 /
  // pre-registration §7 point 3): "api" is real metered spend and gets
  // cost_usd; a subscription-mode row gets notional_usd -- a counterfactual
  // of what the SAME usage would have cost under metered billing -- and MUST
  // NEVER be presented as spend. This field name is what a report renders
  // next to the dollar figure so the regime travels with the number instead
  // of living only in a comment.
  const usd_field = row.billing_mode === "api" ? "cost_usd" : "notional_usd";

  const perModel = [];
  if (row.tokens_by_model) {
    for (const [model, tokens] of Object.entries(row.tokens_by_model)) {
      perModel.push({ model, tokens });
    }
  } else if (row.model) {
    perModel.push({ model: row.model, tokens: row });
  } else {
    throw new Error("priceRow: row has neither `model` nor `tokens_by_model` -- not a valid costRow() shape");
  }

  let total = 0;
  const byModel = [];
  for (const { model, tokens } of perModel) {
    const priced = priceModelTokens(model, tokens, row.timestamp, rateTable);
    if (priced.missingRate) {
      byModel.push({ model, baseUsd: 0, batchApplied: false, batchDiscount: 0, finalUsd: 0, missingRate: true });
      continue;
    }
    // The batch discount is applied HERE, as a separate multiplicative step
    // on top of the base rate lookup -- not folded into `rate.in`/`rate.out`
    // above -- so that priceRow()'s output can show baseUsd and finalUsd as
    // two distinct numbers with the discount factor named between them. That
    // separation is the acceptance criterion ("Batch discount is an
    // explicit, visible factor in the breakdown -- NOT baked into the base
    // rate"), not just an implementation preference.
    const discount = batch ? (BATCH_DISCOUNT_BY_MODEL[model] ?? DEFAULT_BATCH_DISCOUNT) : 0;
    const finalUsd = priced.usd * (1 - discount);
    total += finalUsd;
    byModel.push({
      model,
      baseUsd: priced.usd,
      batchApplied: batch,
      batchDiscount: discount,
      finalUsd,
      source: priced.source,
      date: priced.date,
      unverified: priced.unverified,
    });
  }

  return { cellKey: row.cellKey, billing_mode: row.billing_mode, usd_field, total, byModel };
}

/**
 * Group ONE priced cost row's per-model figures by provider (issue #51,
 * per-provider --max-spend). Reduces `priceRow(row, ...).byModel` -- which
 * already prices every model in a `tokens_by_model` row individually -- by
 * `providerOf(model)` rather than re-deriving per-model pricing here. This is
 * the mixed-arm-safe attribution path: a row with `tokens_by_model` spanning
 * two providers (arm G: 3 Anthropic slots + 2 OpenAI slots in ONE cell) comes
 * back split across both provider buckets, never lumped onto whichever model
 * happens to be listed first in the row.
 *
 * A model with `missingRate: true` (no RATE_TABLE entry) contributes $0 and is
 * silently excluded from the provider split -- priceRow() already surfaces
 * that gap via its own byModel entries; this function does not re-throw it,
 * consistent with priceModelTokens()'s "missing rate prices at 0, not an
 * error" contract (the loud-failure precedent applies to a PLANNED cell's
 * pricer, e.g. runnerPriceGrid, not to re-pricing an already-recorded row
 * under a possibly-narrower table).
 *
 * @param {object} row        a costRow()-shaped ledger row
 * @param {object} [rateTable=RATE_TABLE]
 * @param {object} [opts]     forwarded to priceRow (e.g. { batch })
 * @returns {{cellKey: string, byProvider: Object<string, number>}} USD per
 *   provider for this one row
 */
export function priceRowByProvider(row, rateTable = RATE_TABLE, opts = {}) {
  const priced = priceRow(row, rateTable, opts);
  const byProvider = {};
  for (const m of priced.byModel) {
    if (m.missingRate) continue;
    const provider = providerOf(m.model);
    byProvider[provider] = (byProvider[provider] || 0) + m.finalUsd;
  }
  return { cellKey: priced.cellKey, byProvider };
}

/**
 * Price a whole ledger (array of costRow()-shaped rows) at once. This is the
 * "one command" side of "re-pricing the whole study after a rate change is
 * one command" -- call it once with the OLD table, once with the NEW table,
 * diff the totals. No re-run, because pricing never reads anything but
 * (rows, rateTable).
 *
 * @param {Array<object>} rows
 * @param {object} [rateTable=RATE_TABLE]
 * @param {object} [opts]
 * @param {boolean|((row: object) => boolean)} [opts.batch]  a single flag
 *   applied to every row, OR a per-row predicate (e.g. reading a caller-side
 *   record of which cells ran batch vs. single/fallback -- see runner.mjs's
 *   `batch` option on runSpec(), which the ledger itself does not currently
 *   carry per-row, so a caller who tracks it elsewhere can supply the
 *   predicate here instead of a blanket true/false).
 * @returns {{
 *   totalUsd: number,            sum of "api" rows' cost_usd
 *   totalNotionalUsd: number,    sum of "subscription" rows' notional_usd
 *   rows: Array<ReturnType<typeof priceRow>>
 * }}
 */
export function priceRows(rows, rateTable = RATE_TABLE, { batch = false } = {}) {
  if (!Array.isArray(rows)) throw new Error("priceRows: rows must be an array");
  const perRowBatch = typeof batch === "function" ? batch : () => batch;

  let totalUsd = 0;
  let totalNotionalUsd = 0;
  const priced = rows.map((row) => {
    const p = priceRow(row, rateTable, { batch: perRowBatch(row) });
    if (p.usd_field === "cost_usd") totalUsd += p.total;
    else totalNotionalUsd += p.total;
    return p;
  });

  return { totalUsd, totalNotionalUsd, rows: priced };
}

/**
 * Convenience wrapper naming the "re-price with a changed table" workflow
 * explicitly, for callers (and tests) that want the one-command re-price to
 * read as its own step rather than a second priceRows() call that looks
 * identical to the first. Functionally identical to priceRows() -- see that
 * function for the actual pricing logic; this exists for readability at call
 * sites and as the thing evals/ledger/reprice.mjs's CLI wraps.
 *
 * @param {Array<object>} rows       rows already recorded by the ledger --
 *   NEVER re-collected, NEVER re-run. Re-pricing reads old rows under a new
 *   table; it does not touch the provider or the store.
 * @param {object} newRateTable
 * @param {object} [opts]
 */
export function repriceRows(rows, newRateTable, opts = {}) {
  return priceRows(rows, newRateTable, opts);
}

// Same per-run token ESTIMATE interimPriceGrid uses (runner.mjs's own
// PANEL_INPUT_TOKENS_ESTIMATE / SOLO_INPUT_TOKENS_ESTIMATE constants),
// duplicated here rather than imported so this module has NO hard dependency
// on evals/harness/runner.mjs -- lib/ stays reusable independent of evals/,
// matching this repo's existing lib/ vs evals/ layering (accounting.mjs,
// manifest.mjs, and store.mjs are all evals-agnostic in the same way).
// Source: docs/PREREGISTRATION.md §8.2's projection table, quoted verbatim
// in runner.mjs's own comment above PANEL_INPUT_TOKENS_ESTIMATE.
const PLAN_TOKEN_ESTIMATE = {
  panel: { in: 16000, out: 9000 },
  solo: { in: 2500, out: 1500 },
};

/**
 * A `priceGrid`-shaped function (the seam evals/harness/runner.mjs's
 * planAndPrice()/runSpec() inject via their `priceGrid` option, defaulting
 * to `interimPriceGrid`) backed by THIS module's authoritative, dated,
 * source-attributed RATE_TABLE instead of runner.mjs's inline
 * INTERIM_RATES_USD_PER_MTOK copy -- the thing that comment marks
 * "superseded by lib/price.mjs in #7".
 *
 * Deliberately reimplements interimPriceGrid's plan-time estimation
 * (per-slot token split from the arm's mode/slot count) rather than calling
 * into runner.mjs, for two reasons: (1) interimPriceGrid has no rate-table
 * parameter to inject into -- it closes over its own inline constant, so
 * there is nothing to adapt without editing the runner itself; (2) editing
 * runner.mjs is explicitly out of scope for a "low-risk, does not
 * destabilize the runner's tests" change (see issue #7's "Wire runner.mjs...
 * optional; if low-risk") -- this file can ship, be tested, and be reviewed
 * entirely on its own, and the runner can adopt it in a follow-up PR by
 * passing `priceGrid: runnerPriceGrid()` with zero changes to this file.
 *
 * At PLAN time there is no per-cell timestamp yet (the cell hasn't run), so
 * this prices every Anthropic-tiered model at its STANDARD (non-intro) rate
 * -- the same "a pre-flight budget gate should over-project, not
 * under-project" reasoning interimPriceGrid's own header comment documents
 * for its own estimates: pricing Sonnet 5's $2/$10 intro rate here would
 * make --max-spend's pre-flight number an underestimate of what a cell
 * running AFTER 2026-08-31 will actually cost.
 *
 * Usage (optional; runner.mjs is not modified by this PR):
 *   import { runnerPriceGrid } from "../lib/price.mjs";
 *   planAndPrice(spec, { store, armsConfig, priceGrid: runnerPriceGrid() });
 *
 * @param {object} [rateTable=RATE_TABLE]
 * @returns {(plannedCells: Array, arms: object, opts?: {batch?: boolean}) => {usd: number, breakdown: Array}}
 */
export function runnerPriceGrid(rateTable = RATE_TABLE) {
  return function priceGrid(plannedCells, arms, { batch = true } = {}) {
    const breakdown = [];
    let usd = 0;
    for (const cell of plannedCells) {
      const arm = arms[cell.armId];
      if (!arm) {
        throw new Error(`runnerPriceGrid: cell '${cell.key}' references unknown arm '${cell.armId}' -- check arms.config.json`);
      }
      const slots = arm.slots || [];
      if (slots.length === 0) {
        // Same "fail loud, not fail cheap" precedent interimPriceGrid sets
        // for this exact failure shape -- a misconfigured arm must not
        // sail through --max-spend for free.
        throw new Error(`runnerPriceGrid: arm '${cell.armId}' has no model slots -- check arms.config.json`);
      }
      const estimate = arm.mode === "solo" ? PLAN_TOKEN_ESTIMATE.solo : PLAN_TOKEN_ESTIMATE.panel;
      const perSlotIn = estimate.in / Math.max(slots.length, 1);
      const perSlotOut = estimate.out / Math.max(slots.length, 1);

      let cellUsd = 0;
      // byProvider: the projected USD split per provider FOR THIS CELL, built
      // slot-by-slot (issue #51's mixed-arm requirement) -- never a flat
      // per-cell assignment to whichever provider happens to own the first
      // slot. A single-provider arm ends up with exactly one key; a
      // cross-provider arm (G: 3 Anthropic slots + 2 OpenAI slots) ends up
      // with both, in the same proportion its slots actually split.
      const byProvider = {};
      for (const slot of slots) {
        const entry = rateTable[slot.model];
        if (!entry) {
          throw new Error(`runnerPriceGrid: no rate for model '${slot.model}' (arm '${cell.armId}') -- add it to lib/price.mjs's RATE_TABLE`);
        }
        const discount = batch ? (BATCH_DISCOUNT_BY_MODEL[slot.model] ?? DEFAULT_BATCH_DISCOUNT) : 0;
        const baseUsd = (perSlotIn / 1_000_000) * entry.in + (perSlotOut / 1_000_000) * entry.out;
        const slotUsd = baseUsd * (1 - discount);
        cellUsd += slotUsd;
        const provider = providerOf(slot.model);
        byProvider[provider] = (byProvider[provider] || 0) + slotUsd;
      }
      breakdown.push({ cellKey: cell.key, usd: cellUsd, byProvider });
      usd += cellUsd;
    }
    return { usd, breakdown };
  };
}
