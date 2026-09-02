// provider.mjs — the provider INTERFACE the runner drives, plus a hermetic
// mock implementation, plus the real AnthropicBatchProvider adapter (issue
// #19) and a documented (unimplemented) stub for OpenAIBatchProvider (a
// separate, later issue -- arms G/H, out of scope here).
//
// ── Why an interface at all ──────────────────────────────────────────────────
// Issue #5 is batch-first BY DESIGN, but it does not call real provider batch
// APIs -- that is out of scope here (no network, no invented secrets in a
// hermetic test suite). Instead the batch-vs-single choice is modeled as a
// field on the call the runner makes to a provider: every provider function
// receives `{ mode }` where mode is "batch" or "single". A real adapter reads
// that field and picks the Anthropic/OpenAI Batches endpoint vs. the plain
// Messages endpoint; the mock and the tests can assert which mode the runner
// requested without any of them touching a network socket.
//
// ── The interface ────────────────────────────────────────────────────────────
//   generate(cell, arm, opts) -> { result, tokens, terminalState, failureKind? }
//     cell   : the planned cell { key, armId, briefId, replicate, cfg }
//     arm    : the arm's resolved config from arms.config.json (id, slots, ...)
//     opts   : { mode: "batch" | "single", timestamp }
//   Returns:
//     result          : arbitrary payload if terminalState === "completed"
//                        (e.g. candidate pool); required by RunAccount.complete
//                        and ResultsStore.put on that path.
//     tokens          : { input_tokens, output_tokens, ... } OR
//                        { tokens_by_model: {...} } for a multi-model cell,
//                        matching lib/accounting.mjs costRow()'s two shapes.
//     terminalState   : "completed" | "failed" -- this call never returns
//                        "skipped" (skip is a runner-side budget decision,
//                        made BEFORE any provider call happens -- see runner.mjs).
//     failureKind     : required when terminalState === "failed"; must be one
//                        of lib/accounting.mjs FAILURE_KINDS.
//
// A provider that throws is treated by the runner as `harness_error` (our bug
// -- see FAILURE_KINDS) rather than a modeled provider failure; a well-behaved
// provider should catch its own transport/parse errors and RETURN a failed
// terminalState with the right kind instead of throwing, so those failures are
// distinguishable from a genuine harness defect.

import { createHash } from "node:crypto";
import { FAILURE_KINDS } from "../../lib/accounting.mjs";
import {
  buildRound1Prompt,
  buildRound2Prompt,
  maxTokensForIdeas,
  salvageCandidateArray,
} from "./prompts.mjs";

// ── Reply diagnostics (issue #93) ──────────────────────────────────
//
// The #8 smoke study's 9 lost arm-A cells all landed in ONE bucket
// (`empty_pool`) with ONE detail string, and the run log carried no agent
// error at all -- `complete()` had returned `ok: true` with text, and
// extraction then recovered nothing. "The model returned nothing", "the reply
// was cut off", and "the reply was complete but unparseable" were structurally
// indistinguishable after the fact, which is why diagnosing this at all
// required a fresh PAID probe of the live API. That indistinguishability is
// the most expensive part of the bug, so it is fixed first-class here.
//
// Every model reply now produces a `summarizeReply` record -- stop_reason,
// output tokens, text length, what parsing did, and a bounded head/tail of the
// raw text -- accumulated per cell. On failure `classifyPoolFailure` turns
// those records into (a) the most specific FAILURE_KINDS value available and
// (b) a `detail` string.
//
// ── Why everything goes in `detail` ─────────────────────────────────────────
// `detail` is the ONLY channel that reaches the ledger. runner.mjs rebuilds
// the stored `result` for a failed cell itself (`{ failed: true, failureKind }`),
// so any structured field hung on a failed provider response is discarded --
// only `response.failureKind` and `response.detail` survive. So `detail` leads
// with machine-greppable `key=value` pairs (`cause=truncated replies=1
// truncated=1 ...`) before any human-readable tail, and every embedded raw
// snippet is JSON.stringify'd, because model text contains newlines and quotes
// that would otherwise break both a one-line detail and any line-oriented
// grep over the ledger. `response.diagnostics` is ALSO returned, structured,
// for a future runner that chooses to persist it.
//
// ── Why `parse_failure` and not a new kind ──────────────────────────────────
// lib/accounting.mjs's FAILURE_KINDS already carries `parse_failure` ("model
// replied, extractCandidates recovered nothing"), which is exactly what both
// the truncated and the complete-but-unparseable shapes are, and it is a
// strictly better classification than `empty_pool` for either. Splitting them
// further into `truncated` / `unparseable` is genuinely desirable but requires
// editing FAILURE_KINDS, which is owned by the parallel issue-#90 lane -- so
// this adapter emits `parse_failure` and puts the discriminator in `detail`
// (`cause=truncated` vs `cause=unparseable_complete`), which means the split
// can be made later from the ledger alone, with no re-run.

/** How much of a failed reply's raw text to retain at each end. Bounded: the
 *  detail string goes in the ledger for every failed cell, and an unbounded
 *  raw reply there would be both unreadable and unbounded on disk. */
export const RAW_SNIPPET_CHARS = 240;

/** Hard ceiling on a generated detail string, so one pathological reply cannot
 *  produce a multi-kilobyte ledger row. */
export const MAX_DETAIL_CHARS = 1400;

// ── The batch poll ceiling (issue #92) ───────────────────────────────────────
//
// This used to be a flat 15 minutes, shorter than real batch latency and not
// settable from the CLI. Measured on the study account on 2026-09-02, four
// single-request batches: 2m24s, 9m53s, 21m07s, and one still `in_progress`
// past 20m -- the first two created 23 SECONDS apart. That is an existence
// proof that 15 minutes is too short; four observations in one afternoon are
// emphatically NOT a latency distribution, so the new default is not derived
// from them. It is derived from the API's own stated envelope:
//
//   * Anthropic documents Message Batches as "most batches complete within
//     1 hour; maximum 24 hours" -- 24h is when the API itself gives up and
//     marks the outstanding requests `expired`.
//   * So a ceiling below ~1 hour abandons batches the API considers ordinary,
//     and 24h is the API's own hard bound.
//
// 60 minutes sits at the top of the documented "most" window and ~3x above the
// worst latency actually observed, while staying far below the 24h expiry. The
// reason NOT to simply poll to expiry: runSpec drives cells SEQUENTIALLY, so a
// 24h ceiling lets one stalled cell hold a ~200-cell overnight grid for a day.
// Issue #90 makes `timeout` transient, so the cell is re-planned `todo` next
// invocation rather than destroyed.
//
// What the ceiling bounds, precisely: it is per BATCH, and a panel arm submits
// one batch per round (panel.maxRounds is 2). A cell whose round-1 batch is
// abandoned stops right there -- see the post-abandonment short-circuit in
// #completeBatched -- so the worst ABANDONMENT wait is one ceiling. A cell
// whose rounds are both slow but finish under the ceiling can still take up to
// maxRounds x ceiling; that is ordinary slow progress, not a stall, and is not
// what this bound exists to catch.
// Override per invocation with `node evals/run.mjs --max-poll-minutes N`.
export const DEFAULT_MAX_POLL_MS = 60 * 60 * 1000;

/** Trim a composed detail string to the ledger's row bound. */
function truncateDetail(detail) {
  return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS - 3)}...` : detail;
}

/**
 * Validate an operator-supplied poll ceiling (issue #92). A NaN ceiling is
 * strictly WORSE than the bug it would replace: `Date.now() > NaN` is always
 * false, so the poll loop would never exit at all. A zero/negative ceiling is
 * accepted ONLY as an explicit "abandon immediately" (the tests use -1), so the
 * guard rejects only non-finite values.
 */
function assertPollCeiling(maxPollMs, providerName) {
  if (!Number.isFinite(maxPollMs)) {
    throw new Error(
      `${providerName}: maxPollMs must be a finite number of milliseconds, got ${JSON.stringify(maxPollMs)} -- ` +
        "a NaN ceiling never expires (NaN comparisons are always false), so the poll loop would spin forever instead of failing",
    );
  }
  return maxPollMs;
}

/**
 * The ledger discriminator issue #92 asks for: "we gave up waiting" must be
 * distinguishable from "the API failed". `failureKind` is `timeout` in both the
 * ceiling case and a hypothetical provider-reported one, so the DETAIL string
 * -- the only structured channel that reaches the store (see the header above)
 * -- leads with a greppable `POLL_CEILING_REACHED` token plus the batch handles
 * that were abandoned, how long each was polled, the ceiling it blew, the last
 * observed processing status, and whether the cancel succeeded.
 *
 * The batch ids matter beyond diagnostics: a submitted batch id is durable and
 * re-pollable, so this line is the operator's manual recovery path (and the
 * seam a future automatic resume would build on -- see issue #92's PR body).
 *
 * @param {string} providerName
 * @param {Array<object>} abandoned  records pushed by the flush loop's ceiling branch
 */
export function formatAbandonDetail(providerName, abandoned = []) {
  const rows = abandoned.map((a) => ({
    batch_id: a.batchId,
    elapsed_ms: a.elapsedMs,
    max_poll_ms: a.maxPollMs,
    last_status: a.lastStatus,
    cancelled: a.cancelled,
  }));
  return (
    `${providerName}: POLL_CEILING_REACHED -- gave up waiting; the API did NOT fail. ` +
    `abandoned_batches=${JSON.stringify(rows)}`
  );
}

/** `formatAbandonDetail(...) + " -- "` when this cell abandoned a batch, else "". */
function abandonPrefix(classification, providerName) {
  const abandoned = (classification && classification.abandoned) || [];
  return abandoned.length ? `${formatAbandonDetail(providerName, abandoned)} -- ` : "";
}

/**
 * Best-effort cancel of an in-flight batch we are abandoning (issue #92).
 *
 * Nothing cancelled batches before this: the #8 smoke run's two orphans had to
 * be cancelled by hand. Since #90 re-plans a `timeout` cell, an uncancelled
 * batch keeps billing for work the next invocation is about to pay for again.
 *
 * Three properties this must have, all load-bearing:
 *   1. It can never throw out of `#flush()` -- an abandonment path that itself
 *      explodes leaves every buffered `complete()` promise unresolved, hanging
 *      the run.
 *   2. It never retries (`maxRetries: 0`): we are already over the ceiling, and
 *      a backoff loop here would extend exactly the wait we just gave up on.
 *   3. A cancel FAILURE never changes the failure kind -- the cell is still a
 *      `timeout`. The outcome is recorded in the detail so an operator can see
 *      a batch may still be billing and cancel it by hand.
 *   4. It is WALL-CLOCK BOUNDED. `maxRetries: 0` stops a retry loop but not a
 *      single hung socket, and the abandonment path awaits this before
 *      resolving the buffered `complete()` promises -- so an unbounded cancel
 *      could hang the run outright, which is strictly worse than the ceiling
 *      bug it is cleaning up after (that at least terminated). The bound uses
 *      a real, unref'd timer rather than the injected `sleep`, because tests
 *      inject a no-op sleep that would make the bound win every race.
 *
 * @returns {Promise<true|false|"timed_out">}
 */
// Shared by BOTH providers: for a body-less POST with JSON headers,
// anthropicFetchWithRetry and openaiFetchWithRetry are byte-identical in
// behaviour, so the cancel path has one implementation rather than two.
async function cancelBatchQuietly(fetchImpl, url, headers, { sleep, logger, maxRetries = 0, timeoutMs = CANCEL_TIMEOUT_MS } = {}) {
  const attempt = (async () => {
    try {
      const res = await anthropicFetchWithRetry(fetchImpl, url, headers, undefined, { method: "POST", maxRetries, sleep, logger });
      return !!(res && res.ok);
    } catch {
      return false;
    }
  })();
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  const outcome = await Promise.race([attempt, bound]);
  clearTimeout(timer);
  return outcome;
}

/** Wall-clock bound on the best-effort cancel above. */
export const CANCEL_TIMEOUT_MS = 15 * 1000;

// -- How long a durable batch handle is worth re-polling (issue #103) --------
//
// #103 was filed saying "Anthropic expires batches at 24h -- confirm the
// current figure rather than trusting this line". Confirmed 2026-09-02 against
// platform.claude.com/docs/en/build-with-claude/batch-processing, and the 24h
// figure is real but describes the WRONG clock for resume. Two separate
// windows are documented, and only the second one bounds this feature:
//
//   PROCESSING  "Batches expire if processing does not complete within 24
//               hours." A request that never got sent comes back `expired`,
//               and "You will not be billed for these requests."
//   RESULTS     "Batch results are available for 29 days after creation.
//               After that, you may still view the Batch, but its results
//               will no longer be available for download."
//
// Resume re-polls a batch that was already SUBMITTED, so what it needs is the
// results window, not the processing window: an abandoned batch is recoverable
// for 29 days, not 24 hours. Had the issue's figure been taken on trust, every
// handle older than a day would have been discarded as dead while its results
// were still sitting there for another four weeks.
//
// OpenAI: "Each batch completes within 24 hours", the completion window can
// "only be set to 24h", and "The output file will automatically be deleted 30
// days after the batch is complete" (developers.openai.com/api/docs/guides/batch,
// same date). Verified independently rather than generalised from Anthropic's
// figures -- the two APIs happen to agree closely here, but nothing guaranteed
// they would.
export const ANTHROPIC_RESULTS_RETENTION_DAYS = 29;
export const OPENAI_RESULTS_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ANTHROPIC_RESULTS_RETENTION_MS = ANTHROPIC_RESULTS_RETENTION_DAYS * DAY_MS;
const OPENAI_RESULTS_RETENTION_MS = OPENAI_RESULTS_RETENTION_DAYS * DAY_MS;

/**
 * True if a handle submitted at `submittedAt` is past the provider's results
 * retention window and is therefore not worth a network call.
 *
 * An unparseable or missing `submittedAt` returns FALSE -- "not known to be
 * expired". Guessing "expired" on a missing timestamp would silently throw
 * away a recoverable batch and re-spend for it, which is the exact failure
 * this whole feature exists to prevent; guessing "live" costs one wasted GET.
 */
export function batchResultsExpired(submittedAt, retentionMs, now = Date.now()) {
  if (!submittedAt) return false;
  const t = Date.parse(submittedAt);
  if (!Number.isFinite(t)) return false;
  return now - t > retentionMs;
}

/**
 * Build the per-reply diagnostic record. Provider-agnostic: callers normalize
 * their provider's stop-reason vocabulary to Anthropic's before calling (see
 * `normalizeOpenAIFinishReason`) so downstream classification reads ONE
 * vocabulary.
 *
 * @param {object} o
 *   @param {string} [o.model]
 *   @param {string} [o.stopReason]  normalized: "end_turn" | "max_tokens" | "refusal" | ...
 *   @param {object} [o.usage]       provider usage object
 *   @param {string} [o.text]        the raw reply text
 *   @param {object} [o.salvage]     the salvageCandidateArray() result, if run
 */
export function summarizeReply({ model, stopReason, usage, text, salvage } = {}) {
  const outputTokens = usage ? usage.output_tokens ?? usage.completion_tokens ?? 0 : 0;
  let parse = "unparsed";
  if (salvage) {
    if (salvage.parsedDirectly) parse = "ok";
    else if (salvage.objects.length > 0) parse = "salvaged";
    else parse = "failed";
  }
  const t = typeof text === "string" ? text : "";
  return {
    model: model || null,
    stopReason: stopReason || null,
    // The truncation discriminator. Anthropic reports it directly; the OpenAI
    // path normalizes finish_reason "length" to "max_tokens" so this one test
    // covers both providers.
    truncated: stopReason === "max_tokens",
    outputTokens,
    textLength: t.length,
    parse,
    parseError: (salvage && salvage.error) || null,
    candidateCount: salvage ? salvage.objects.length : 0,
    droppedCount: salvage ? salvage.dropped : 0,
    textHead: t.slice(0, RAW_SNIPPET_CHARS),
    textTail: t.length > RAW_SNIPPET_CHARS ? t.slice(-RAW_SNIPPET_CHARS) : "",
  };
}

/**
 * Run salvage over a reply, record its diagnostics, and return the
 * `complete()` payload ideate-core expects.
 *
 * A reply that parsed cleanly is handed through BYTE-FOR-BYTE -- the happy
 * path is not perturbed. A reply that needed repair is re-serialized from the
 * objects that survived, so ideate-core's extractCandidates (which parses the
 * reply as one JSON document) sees valid JSON and keeps the 29 good ideas
 * instead of discarding all 30. A reply from which nothing at all could be
 * recovered is passed through unchanged, so behaviour in the genuinely-hopeless
 * case is exactly what it was before.
 */
export function handleReplyText({ model, stopReason, usage, text, diagnostics }) {
  const salvage = salvageCandidateArray(text);
  if (Array.isArray(diagnostics)) {
    diagnostics.push(summarizeReply({ model, stopReason, usage, text, salvage }));
  }
  if (salvage.parsedDirectly || salvage.objects.length === 0) return { ok: true, text };
  return { ok: true, text: JSON.stringify(salvage.objects) };
}

/**
 * Turn a cell's reply diagnostics into a FAILURE_KINDS value plus a greppable
 * detail string, for the case where the candidate pool came back empty.
 *
 * @param {Array} diagnostics  summarizeReply() records, in call order.
 * @param {object} [o]
 *   @param {string} [o.providerName]  prefix for the detail string.
 *   @param {boolean} [o.allRefused]   ideate-core's own agentsFailed === agentsAttempted signal.
 * @returns {{kind: string, cause: string, detail: string}}
 */
export function classifyPoolFailure(diagnostics = [], { providerName = "provider", allRefused = false } = {}) {
  const replies = diagnostics.length;
  const truncated = diagnostics.filter((d) => d.truncated).length;
  const refused = diagnostics.filter((d) => d.stopReason === "refusal").length;
  const unparseable = diagnostics.filter((d) => !d.truncated && d.parse === "failed").length;
  const salvaged = diagnostics.filter((d) => d.parse === "salvaged").length;
  const emptyValid = diagnostics.filter((d) => d.parse === "ok" && d.candidateCount === 0).length;

  const stopReasons = {};
  for (const d of diagnostics) {
    const k = d.stopReason || "unknown";
    stopReasons[k] = (stopReasons[k] || 0) + 1;
  }

  let kind;
  let cause;
  if (replies > 0 && refused === replies) {
    kind = "refusal";
    cause = "refusal";
  } else if (truncated > 0) {
    kind = "parse_failure";
    cause = "truncated";
  } else if (unparseable > 0) {
    kind = "parse_failure";
    cause = "unparseable_complete";
  } else if (allRefused) {
    // ideate-core's own "every agent failed" signal. Checked AFTER the
    // reply-level causes (which are strictly more specific and more
    // actionable) but BEFORE the empty_pool fallbacks, which preserves the
    // pre-#93 behaviour: agentsFailed === agentsAttempted classified refusal.
    kind = "refusal";
    cause = "agents_all_failed";
  } else if (replies === 0) {
    // No reply was ever recorded -- the model was never successfully reached.
    // Nothing here is more specific than the caller's own transport signals.
    kind = "empty_pool";
    cause = "no_replies";
  } else {
    // Every reply parsed and every reply was legitimately empty -- the model
    // really did return nothing usable. THIS is what `empty_pool` was always
    // supposed to mean.
    kind = "empty_pool";
    cause = "genuinely_empty";
  }

  // Pick the most diagnostic single reply to quote: a truncated one first,
  // then an unparseable one, then whatever came back.
  const sample =
    diagnostics.find((d) => d.truncated) || diagnostics.find((d) => d.parse === "failed") || diagnostics[0] || null;

  const fields = [
    `cause=${cause}`,
    `kind=${kind}`,
    `replies=${replies}`,
    `truncated=${truncated}`,
    `unparseable=${unparseable}`,
    `salvaged=${salvaged}`,
    `refused=${refused}`,
    `empty_valid=${emptyValid}`,
    `stop_reasons=${JSON.stringify(stopReasons)}`,
  ];
  if (sample) {
    fields.push(
      `sample_model=${sample.model}`,
      `sample_stop_reason=${sample.stopReason}`,
      `sample_output_tokens=${sample.outputTokens}`,
      `sample_text_len=${sample.textLength}`,
      `sample_parse=${sample.parse}`,
      `sample_dropped=${sample.droppedCount}`,
      `sample_parse_error=${JSON.stringify(sample.parseError)}`,
      `sample_head=${JSON.stringify(sample.textHead)}`,
      `sample_tail=${JSON.stringify(sample.textTail)}`,
    );
  }

  let detail = `${providerName}: ideateCore returned an empty candidate pool -- ${fields.join(" ")}`;
  if (detail.length > MAX_DETAIL_CHARS) detail = `${detail.slice(0, MAX_DETAIL_CHARS - 3)}...`;
  return { kind, cause, detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE UNDERSIZED-POOL RULE (issue #102)
// ─────────────────────────────────────────────────────────────────────────────
//
// ── The rule ────────────────────────────────────────────────────────────────
// A cell whose pool was assembled from FEWER agents than its arm specifies does
// not complete. It fails, with the most specific kind the evidence supports.
// There is no threshold and no "complete but flagged" middle ground.
//
// ── Why, in one line ────────────────────────────────────────────────────────
// #92 already established this exact rule one door over: a pool missing a whole
// ROUND (round 1 returned, round 2 blew the poll ceiling) fails `timeout` rather
// than storing a truncated pool, "because storing it would silently under-report
// this cell's pool size." A pool missing three of five AGENTS in every round is
// the same defect arriving through a different trigger. Completing it while
// failing the other would be an inconsistency in what a `completed` cell means,
// not a considered policy.
//
// ── Why not a completeness threshold ────────────────────────────────────────
// A threshold ("fail below 4 of 5") is a tunable that has to be justified and
// pre-registered, and any value for it still admits a biased pool -- it only
// moves the size of the bias, and `distinct_k` scales with pool size, so the
// residual bias stays arm-correlated. There is no principled place to put it.
//
// ── Why not "complete, but record the realized count" ───────────────────────
// Nothing in evals/analysis/ reads such a field today, and an unread field is
// the same as no field: the cell is still counted as data. The realized counts
// ARE retained (see below and runner.mjs) -- but as diagnostics on a cell whose
// state already tells the truth, never as the mechanism by which an undersized
// pool is made safe.
//
// ── Why the loss this creates is acceptable ─────────────────────────────────
// ideate-core tolerates individual agent failures BY DESIGN (`onAgentError`
// resolves to `null` rather than throwing), so this rule fails cells the engine
// considers healthy. That is the right trade for a measurement instrument
// rather than a product: for an ENVIRONMENTAL cause (a 429, a 5xx, a timeout)
// the kind is transient, so #90 keeps `cell.key` out of the store and the next
// invocation re-plans the cell with its spend preserved -- the cost is a delay,
// not a lost cell. Only an INTRINSIC cause makes the failure permanent, and
// that case is a real observation about the arm (see the residual registered in
// docs/PREREGISTRATION.md §10).
//
// ── What counts as "fewer agents than the arm specifies" ────────────────────
// Either of two independent channels -- `meta.agentsFailed > 0`, or a reply
// that came back and yielded nothing usable for a mechanical/refusal reason.
// See classifyUndersizedPool's own doc for why ONE channel was not enough (the
// partial-refusal / partial-parse_failure case the issue asked about can arrive
// without ideate-core counting an agent as failed at all).
//
// The agent-level channel is `meta.agentsFailed > 0`, i.e. ideate-core's OWN
// attempted count minus its own failed count. Deliberately NOT compared against
// `arm.slots.length`: this repo
// runs its whole test suite with an EMPTY node_modules (see this module's
// header), so whether ideate-core@0.4.0 counts `agentsAttempted` per ROUND (5
// for a panel) or per RUN (10 across two rounds) is not verifiable here. Under
// per-run semantics a cell that lost all five agents in round 2 realizes 5,
// and `5 < arm.slots.length` would MISS it. `agentsFailed > 0` is correct under
// either semantics, and `resolveIdeateAgents` maps slots to agents 1:1, so "an
// attempted agent that did not contribute" IS "fewer agents than the arm
// specifies".

/**
 * Classify a NON-EMPTY pool that was assembled from fewer agents than the arm
 * specifies -- the partial-round counterpart of `classifyPoolFailure` above.
 *
 * The two have deliberately different decision orders. `classifyPoolFailure`
 * asks "the pool is empty; what emptied it?" and requires unanimity for
 * `refusal` (`refused === replies`). This one asks "some agents dropped out;
 * why?" -- so ANY refusal, truncation or unparseable reply among the replies
 * that DID come back is enough to name the cause.
 *
 * ── TWO independent shortfall channels, because ONE was not enough ──────────
 * The issue asked whether partial `refusal` / partial `parse_failure` share the
 * rate-limit case's shape. They do, AND they can arrive without ideate-core
 * counting an agent as failed at all, so a `meta.agentsFailed` test alone would
 * have missed them:
 *
 *   1. AGENT-LEVEL. `meta.agentsFailed > 0` -- an agent whose `complete()` call
 *      never produced a usable reply. This is the 429/5xx/timeout channel: the
 *      request itself failed, so there is no reply and no diagnostic for it.
 *
 *   2. REPLY-LEVEL. An agent whose request SUCCEEDED and whose reply yielded no
 *      usable candidates for a mechanical or refusal reason -- refused,
 *      truncated with nothing salvageable, or complete-but-unparseable. Whether
 *      ideate-core counts such a reply in `agentsFailed` is NOT verifiable from
 *      this repo (empty node_modules -- see the module header; the two fake
 *      `ideateImpl`s in this repo's own test suite disagree with each other on
 *      exactly this point). So the shortfall is detected from the per-reply
 *      diagnostics directly instead of being taken on trust from the engine.
 *
 * ── What is deliberately NOT a shortfall ────────────────────────────────
 *   - A reply that contributed FEWER IDEAS than requested (a truncation from
 *     which #93's salvage recovered 28 of 30). That is an idea-count axis, not
 *     an agent-count one; #93 registered the salvage trade deliberately and
 *     re-litigating it here would silently widen this issue.
 *   - A reply that parsed cleanly and was legitimately EMPTY (`[]`). That is the
 *     arm's own answer -- `classifyPoolFailure`'s `genuinely_empty` -- and it is
 *     a measurement, not a lost one.
 *
 * Transport-level signals are NOT consulted here: the caller composes this with
 * `pickFailureKind(classification, ...)`, which lets a 429/timeout/5xx win over
 * whatever the surviving replies happen to look like -- the same composition
 * every other failure path in this module uses.
 *
 * @param {object|null} ideateResult  the engine's own result, for its `meta`
 * @param {Array} diagnostics  summarizeReply() records for the replies that DID
 *   come back (an agent whose request failed contributes none, by construction).
 * @param {object} o
 *   @param {string} [o.providerName]
 *   @param {number} o.candidateCount   the size of the pool that would be stored
 * @returns {{kind: string, cause: string, detail: string} | null}  null when the
 *   pool is NOT undersized -- i.e. when the cell may legitimately complete.
 */
export function classifyUndersizedPool(ideateResult, diagnostics = [], { providerName = "provider", candidateCount = 0 } = {}) {
  const replies = diagnostics.length;
  const truncated = diagnostics.filter((d) => d.truncated).length;
  const refused = diagnostics.filter((d) => d.stopReason === "refusal").length;
  const unparseable = diagnostics.filter((d) => !d.truncated && d.parse === "failed").length;
  // Channel 2: a reply that came back and yielded NOTHING for a mechanical or
  // refusal reason. `candidateCount === 0` is the load-bearing conjunct -- it is
  // what keeps a partially-salvaged truncation (28 of 30 recovered) out of this
  // set, per "what is deliberately NOT a shortfall" above.
  const nonContributingReplies = diagnostics.filter(
    (d) => d.candidateCount === 0 && (d.truncated || d.parse === "failed" || d.stopReason === "refusal"),
  ).length;

  const realized = realizedAgents(ideateResult);
  const agentsFailed = realized ? realized.failed : 0;
  if (agentsFailed === 0 && nonContributingReplies === 0) return null;

  let kind;
  let cause;
  if (truncated > 0) {
    // Same precedence classifyPoolFailure uses: a truncated reply is the most
    // specific and most actionable signal there is (it names a max_tokens
    // problem, not a model problem).
    kind = "parse_failure";
    cause = "partial_truncated";
  } else if (refused > 0) {
    // Refusal outranks `unparseable` here, and the order is load-bearing rather
    // than arbitrary: a refusal reply is prose ("I can't help with that"), so it
    // ALSO fails to parse as JSON and would otherwise be recorded as a
    // parse_failure -- blaming our parser for the model's decision. `stop_reason`
    // is the provider's own statement of why it stopped, which is the more
    // authoritative signal. (classifyPoolFailure reaches the same conclusion by
    // a different route: its unanimous-refusal test runs before its parse tests.)
    kind = "refusal";
    cause = "partial_refusal";
  } else if (unparseable > 0) {
    kind = "parse_failure";
    cause = "partial_unparseable_complete";
  } else {
    // Agents dropped out leaving no reply diagnostic at all, and no transport
    // signal was raised for them either (or the caller's pickFailureKind would
    // have overridden this fallback). Nothing in the evidence explains the
    // shortfall, which makes it OUR gap rather than a datum about the arm --
    // `harness_error`, which is transient, so the cell is re-planned rather
    // than recorded as a property of the arm on the strength of no evidence.
    kind = "harness_error";
    cause = "partial_unexplained";
  }

  const fields = [
    `cause=${cause}`,
    `kind=${kind}`,
    `agents_attempted=${realized ? realized.attempted : "unreported"}`,
    `agents_failed=${realized ? realized.failed : "unreported"}`,
    `agents_realized=${realized ? realized.realized : "unreported"}`,
    `non_contributing_replies=${nonContributingReplies}`,
    `discarded_candidates=${candidateCount}`,
    `replies=${replies}`,
    `truncated=${truncated}`,
    `unparseable=${unparseable}`,
    `refused=${refused}`,
  ];
  const shortfall = Math.max(agentsFailed, nonContributingReplies);
  let detail =
    `${providerName}: discarding an UNDERSIZED pool of ${candidateCount} candidate(s) -- at least ${shortfall} agent(s) ` +
    `did not contribute, so this pool is smaller than the arm specifies and storing it would silently under-report ` +
    `this cell's pool size (issue #102) -- ${fields.join(" ")}`;
  if (detail.length > MAX_DETAIL_CHARS) detail = `${detail.slice(0, MAX_DETAIL_CHARS - 3)}...`;
  return { kind, cause, detail };
}

/**
 * Read ideate-core's realized-agent bookkeeping off an ideateResult, normalized
 * and validated. Returns `null` when the engine reported nothing usable, which
 * is "cannot verify" and never "nothing failed" -- the two must not collapse.
 */
export function realizedAgents(ideateResult) {
  const meta = ideateResult && ideateResult.meta;
  if (!meta) return null;
  const attempted = meta.agentsAttempted;
  const failed = meta.agentsFailed;
  if (!Number.isInteger(attempted) || !Number.isInteger(failed)) return null;
  if (attempted < 0 || failed < 0 || failed > attempted) return null;
  return { attempted, failed, realized: attempted - failed };
}

/**
 * The per-cell max_tokens ceiling: the largest any of this cell's agents could
 * need. Cells are homogeneous in ideasPerAgent today (solo: totalIdeasRequested;
 * panel: panel.ideasPerAgent for every slot), so this is just "what this arm
 * asks for" -- taking the max keeps it correct if that ever stops holding.
 * Guards the empty-agents case explicitly: `Math.max(...[])` is -Infinity.
 */
export function maxTokensForCell(agents) {
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  if (list.length === 0) return maxTokensForIdeas(undefined);
  return Math.max(...list.map((a) => maxTokensForIdeas(a.ideasPerAgent)));
}

// ══ BATCH RESUME (issue #103) ══════════════════════════════════════
//
// A batch that outran the poll ceiling (#92) was, before this, simply lost
// money: the cell fails `timeout`, #90 re-plans it `todo`, and the next
// invocation submits a BRAND NEW batch. The provider had already produced
// those replies and will hand them over again for free -- results stay
// downloadable for 29 days after batch creation (verified 2026-09-02 against
// platform.claude.com/docs/en/build-with-claude/batch-processing; OpenAI
// deletes the output file 30 days after completion, per
// developers.openai.com/api/docs/guides/batch).
//
// ── Why this is request-level replay and not "reload a saved batch id" ────
// A batch is per ROUND, and ideate-core keeps no durable inter-round state.
// Resuming a cell whose ROUND 2 batch was abandoned means re-entering the
// engine, which re-issues ROUND 1 first. Reloading a batch id alone would
// recover round 2 and re-pay for round 1. So the unit of resume is the
// REQUEST: every reply this cell has ever received is cached by a
// content-derived custom_id, and a re-issued request that matches one is
// served from the cache instead of the network.
//
// That the replay reproduces at all rests on one property of ideate-core@0.4.0
// worth naming, because resume silently degrades to round-1-only if it ever
// stops holding: round-2 prompts are a deterministic function of the round-1
// pool in AGENT order, not completion order. `ideateCore` collects round 1 via
// `Promise.all` over `agents` (which resolves in INPUT order regardless of
// which reply landed first), assembles `candidates` by iterating `agents` in
// order, and derives round 2's `seeds` as `dedupe(candidates.slice())`. Batch
// results arrive in arbitrary JSONL order and are keyed by custom_id, never by
// position -- so the round-1 pool, and therefore every round-2 prompt, is
// byte-identical across a re-issue.
//
// ── Cancel-on-abandon stays ON, and partial recovery is the NORMAL case ───
// #92 cancels an abandoned batch by default, and #103 was filed expecting that
// default to have to flip, on the premise that cancelling destroys the handle
// resume would re-poll. That premise is false. Per the Anthropic docs above, a
// `canceled` per-request result means only "user canceled the batch BEFORE
// this request could be sent to the model", those requests are explicitly not
// billed, and everything already sent still `succeeded`, is still billed, and
// is still in the results file. Cancelling therefore CAPS the unattended
// billing exposure while PRESERVING everything already paid for -- the two
// features are complements, not alternatives, and the default does not flip.
//
// The consequence is that a recovered batch is usually PARTIAL: some
// `succeeded`, some `canceled`. Per-request replay handles that natively --
// the succeeded ones are served free and only the canceled ones are re-issued.
// A per-batch "reload the id" design could not have expressed it at all.

/** Sorted-key JSON, so a request's identity does not depend on the order its
 *  properties happened to be constructed in. */
function canonicalRequestJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalRequestJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalRequestJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * A CONTENT-DERIVED, stable `custom_id` for one batched request (#103 AC1).
 *
 * Before this, ids were `req-<i>-<Math.random()>` -- unique within a batch and
 * meaningless outside it, which is precisely why nothing could match a
 * persisted reply back to a re-issued request. Here the id is a hash of the
 * exact params object being sent, so the SAME request re-issued in a later
 * session derives the SAME id and finds its own prior reply.
 *
 * `counts` disambiguates the case where two requests in one cell serialize
 * identically (a mixed arm could in principle give two slots the same persona
 * AND model). The occurrence index is taken per CELL, not per batch, and that
 * distinction is load-bearing: on a resume some requests are served from cache
 * and never reach a batch at all, so a per-batch counter would renumber the
 * survivors and hand request #1 the id that belonged to request #0. ideate-core
 * issues a round's `complete()` calls in agent order, so a per-cell counter is
 * deterministic across re-issues.
 *
 * Format: `r<40 hex>-<n>` -- 43 chars, well inside Anthropic's documented
 * `^[a-zA-Z0-9_-]{1,64}$`.
 *
 * @param {object} params  the provider params object as it will be sent
 * @param {Map<string, number>} counts  per-cell occurrence counter, mutated
 */
export function contentCustomId(params, counts) {
  const digest = createHash("sha256").update(canonicalRequestJson(params)).digest("hex").slice(0, 40);
  const n = counts && typeof counts.get === "function" ? counts.get(digest) || 0 : 0;
  if (counts && typeof counts.set === "function") counts.set(digest, n + 1);
  return `r${digest}-${n}`;
}

/**
 * The replay/handle state one `generate()` call starts from and hands back.
 * Normalised here so neither adapter has to defend against a half-shaped
 * `opts.resume` and both return the same thing for the runner to persist.
 */
export function normalizeResumeState(resume) {
  const replies = resume && resume.replies && typeof resume.replies === "object" ? { ...resume.replies } : {};
  const outstanding = resume && Array.isArray(resume.outstanding) ? [...resume.outstanding] : [];
  return { replies, outstanding };
}

/**
 * Validate a provider's return shape against the interface contract above.
 * Runner-internal helper, exported so tests can reuse it if they hand-roll a
 * provider double instead of using MockProvider.
 */
export function assertValidProviderResponse(resp) {
  if (!resp || typeof resp !== "object") {
    throw new Error("provider.generate: must return an object");
  }
  if (resp.terminalState !== "completed" && resp.terminalState !== "failed") {
    throw new Error(
      `provider.generate: terminalState must be "completed" or "failed", got ${JSON.stringify(resp.terminalState)} ` +
        `(a provider never returns "skipped" -- skip decisions are made by the runner before any call)`,
    );
  }
  if (resp.terminalState === "failed") {
    if (!FAILURE_KINDS.includes(resp.failureKind)) {
      throw new Error(`provider.generate: failed response has unrecognized failureKind '${resp.failureKind}'`);
    }
  }
  if (resp.terminalState === "completed" && (!resp.result || typeof resp.result !== "object")) {
    throw new Error("provider.generate: a completed response must carry a result object");
  }
  return resp;
}

/**
 * MockProvider — the hermetic double the test suite drives. No network, no
 * timers, deterministic. Supports scripted per-cell overrides so a test can
 * force a specific cell to fail with a specific kind (AC4) while every other
 * cell completes normally.
 *
 * @param {object} [opts]
 *   @param {Map<string,object>} [opts.overrides]  key -> partial response to
 *     merge over the default completed response (e.g. force a failure).
 *   @param {number} [opts.latencyMs]  recorded on every completed result, so
 *     evals/metrics/operational.mjs's latencyPercentiles() has something to
 *     read in an integration test.
 */
export class MockProvider {
  constructor({ overrides = new Map(), latencyMs = 1 } = {}) {
    this.overrides = overrides;
    this.latencyMs = latencyMs;
    /** Every call this mock received, in order -- the spy the ACs assert against
     *  (e.g. "--dry-run calls nothing" asserts this stays empty). */
    this.calls = [];
  }

  async generate(cell, arm, opts = {}) {
    this.calls.push({ key: cell.key, armId: cell.armId, mode: opts.mode });

    const override = this.overrides.get(cell.key);
    if (override) {
      return assertValidProviderResponse({ ...defaultCompletion(cell, arm, this.latencyMs), ...override });
    }
    return assertValidProviderResponse(defaultCompletion(cell, arm, this.latencyMs));
  }
}

function defaultCompletion(cell, arm, latencyMs) {
  // A minimal, deterministic "pool" -- just enough shape for downstream
  // metrics/store code to have something real to store. Content is not the
  // point of this mock; call-accounting and state-machine correctness are.
  const slots = (arm && arm.slots) || [];
  const tokens_by_model = {};
  for (const slot of slots) {
    tokens_by_model[slot.model] = tokens_by_model[slot.model] || { input_tokens: 0, output_tokens: 0 };
    tokens_by_model[slot.model].input_tokens += 500;
    tokens_by_model[slot.model].output_tokens += 300;
  }
  return {
    terminalState: "completed",
    result: {
      candidates: [`mock-idea-1-${cell.key}`, `mock-idea-2-${cell.key}`],
      latencyMs,
    },
    tokens: { tokens_by_model },
  };
}

// ── AnthropicBatchProvider: the real adapter (issue #19) ────────────────────
//
// Wires ideate-core@0.4.0 in as the engine under test and drives it against
// the real Anthropic Message Batches API (batch mode, the DEFAULT) or plain
// Messages API (single mode, --no-batch only). Every seam that would touch
// the network, timers, or ideate-core itself is INJECTABLE with a live
// default -- see the constructor -- so evals/harness/anthropic-batch.test.mjs
// exercises this class with zero network and an EMPTY node_modules (fake
// fetchImpl + fake ideateImpl), preserving the hermetic-CI invariant this
// repo's tests depend on (see the header comment on this file and CI's
// `node --test` with no `npm install`).
//
// ── Why ideate-core is loaded via dynamic import, not a top-level one ───────
// This file is imported by evals/harness/provider.test.mjs, which in turn is
// loaded by `node --test` in CI with an EMPTY node_modules. A top-level
// `import "ideate-core"` here would throw MODULE_NOT_FOUND before a single
// test runs. `ideateImpl`'s LIVE default reaches ideate-core with
// `await import("ideate-core")` -- deferred until the first real `generate()`
// call, which only happens outside the test suite (tests always inject a
// fake `ideateImpl`).
//
// ── The barrier-batcher ──────────────────────────────────────────────────────
// ideate-core dispatches a round's N agents via `Promise.all(agents.map(...))`
// (see node_modules/ideate-core/lib/ideate-core.mjs) -- so all N `complete(req)`
// calls for a given round happen SYNCHRONOUSLY within one microtask tick, with
// no signal marking "this is the last one". We turn that into ONE Message
// Batch per round by buffering: every `complete(req)` call pushes
// `{req, resolve, reject}` onto `this.#pending` and, on the FIRST push of a
// fresh batch, schedules `this.#flush()` via `setTimeout(fn, 0)` -- a
// subsequent-MACROTASK debounce, which fires only after every synchronously
// queued microtask (i.e. every agent's `complete()` call for this round) has
// already pushed onto the buffer. `flush()` then submits everything
// accumulated as a single batch and resolves each caller by `custom_id`.
export class AnthropicBatchProvider {
  /**
   * @param {object} [opts]
   *   @param {string} [opts.apiKey]           Anthropic API key. Required for
   *     any real call; if absent, generate() returns a classified failure
   *     (harness_error) on the FIRST call rather than throwing -- see below.
   *     (The CLI itself already guards this with a loud pre-flight error;
   *     this fallback exists so the class is safe to construct/use directly,
   *     e.g. from a test or a script that bypasses run.mjs.)
   *   @param {Array}  [opts.corpus]           CORPUS -- array of briefs, each
   *     `{ id, text, ... }`. Brief text is looked up by `cell.briefId`.
   *   @param {object} [opts.armsConfig]       parsed arms.config.json, used
   *     for `panel.ideasPerAgent` / `panel.maxRounds`.
   *   @param {typeof fetch} [opts.fetchImpl]  INJECTED in tests; defaults to
   *     globalThis.fetch for live use.
   *   @param {Function} [opts.ideateImpl]     `(input, deps) => Promise<{candidates,...}>`.
   *     Live default dynamically imports ideate-core (see above); tests
   *     inject a fake so no real engine call happens.
   *   @param {Function} [opts.sleep]          `(ms) => Promise<void>`; injectable
   *     for fast, deterministic retry/backoff tests.
   *   @param {number} [opts.pollIntervalMs]   batch-poll interval (live default 2000ms).
   *   @param {number} [opts.maxPollMs]        poll ceiling before classifying `timeout`
   *     (live default DEFAULT_MAX_POLL_MS -- see that constant for why 60 min).
   *   @param {boolean} [opts.cancelOnAbandon] issue #92: cancel an in-flight batch when the
   *     poll ceiling is reached, so it does not bill unattended for work #90 is about to
   *     re-submit. Default true; set false to leave the handle live for a manual re-poll.
   *     Still true after #103 -- cancelling PRESERVES already-succeeded results (see the
   *     BATCH RESUME section above), so it caps exposure without costing resume anything.
   *   @param {boolean} [opts.resume]          issue #103: serve a re-issued request from a
   *     previously recovered reply, and re-poll a batch handle abandoned in an earlier
   *     session, instead of paying for it twice. Default true. Batch mode only.
   *   @param {number} [opts.maxRetries]       429/5xx retry budget before classifying (default 3).
   *   @param {(msg: string) => void} [opts.logger]  defaults to console.error; tests inject a silent logger.
   */
  constructor({
    apiKey = process.env.ANTHROPIC_API_KEY,
    corpus = [],
    armsConfig,
    fetchImpl = globalThis.fetch,
    ideateImpl = async (...a) => (await import("ideate-core")).ideateCore(...a),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs = 2000,
    maxPollMs = DEFAULT_MAX_POLL_MS,
    cancelOnAbandon = true,
    resume = true,
    maxRetries = 3,
    logger = (msg) => console.error(msg),
  } = {}) {
    this.apiKey = apiKey;
    this.corpus = corpus;
    this.armsConfig = armsConfig;
    this.fetchImpl = fetchImpl;
    this.ideateImpl = ideateImpl;
    this.sleep = sleep;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPollMs = assertPollCeiling(maxPollMs, "AnthropicBatchProvider");
    this.cancelOnAbandon = cancelOnAbandon;
    this.resume = resume;
    this.maxRetries = maxRetries;
    this.logger = logger;

    // Barrier-batcher state -- see the class header comment. Reset per
    // in-flight batch: `#pending` accumulates {req, resolve, reject} entries;
    // `#flushScheduled` guards against scheduling more than one flush timer
    // per batch.
    this.#pending = [];
    this.#flushScheduled = false;
  }

  #pending;
  #flushScheduled;

  /**
   * The interface method (see the file header). Never throws for a transport
   * failure -- every catchable error is classified via FAILURE_KINDS and
   * returned, per the interface contract.
   *
   * Issue #103: a thin wrapper around the real body so that the resume state
   * (`{replies, outstanding}`) is attached to EVERY return path exactly once,
   * rather than being threaded through each of the six classified-failure
   * returns by hand -- one of which would eventually be missed, and a missed
   * one silently drops a recovered reply on the floor and re-pays for it.
   * The runner owns persisting what comes back; the provider does no store I/O.
   */
  async generate(cell, arm, opts = {}) {
    const mode = (opts && opts.mode) || "batch";
    // Resume is batch-only by construction: `single` mode never produces a
    // batch handle, and replaying batch-produced replies into a single-mode
    // run is exactly the wrong-RATE hazard lib/store.mjs's #103 header
    // describes. The runner enforces the same rule one level up, from the
    // durable record's own `pricingLever`; this is the provider-side half.
    const resumeEnabled = !!this.resume && mode === "batch";
    const state = normalizeResumeState(resumeEnabled ? opts.resume : null);
    const resp = await this.#generate(cell, arm, opts, state, resumeEnabled);
    return resumeEnabled ? { ...resp, resume: { replies: state.replies, outstanding: state.outstanding } } : resp;
  }

  async #generate(cell, arm, { mode = "batch", timestamp } = {}, state = { replies: {}, outstanding: [] }, resumeEnabled = false) {
    if (!this.apiKey) {
      // The CLI (evals/run.mjs) already fails loudly BEFORE constructing this
      // provider when ANTHROPIC_API_KEY is unset -- this branch is a second
      // line of defense for direct construction (e.g. a script, a future
      // caller) that skips the CLI's guard. Classified as harness_error: a
      // missing key is a caller/config bug, not a modeled provider failure
      // (rate limit, refusal, etc.) -- it never even reaches the network.
      return {
        terminalState: "failed",
        failureKind: "harness_error",
        detail: "AnthropicBatchProvider: no apiKey (ANTHROPIC_API_KEY unset) -- refusing to call the network with no credential",
        tokens: { tokens_by_model: {} },
      };
    }

    const brief = this.corpus.find((b) => b.id === cell.briefId);
    if (!brief) {
      return {
        terminalState: "failed",
        failureKind: "harness_error",
        detail: `AnthropicBatchProvider: no corpus brief found for briefId '${cell.briefId}'`,
        tokens: { tokens_by_model: {} },
      };
    }

    const { agents, maxRounds } = resolveIdeateAgents(arm, this.armsConfig);

    // Per-call token accounting, scoped to THIS generate() invocation (one
    // cell). Populated by every `complete()` resolution below, success or
    // failure, so a partially-completed cell still reports what it consumed
    // (spec: "Return tokens even on failure").
    const tokensByModel = {};
    const addUsage = (model, usage) => {
      if (!model || !usage) return;
      const row = (tokensByModel[model] = tokensByModel[model] || {
        input_tokens: 0,
        output_tokens: 0,
      });
      row.input_tokens += usage.input_tokens || 0;
      row.output_tokens += usage.output_tokens || 0;
      if (usage.cache_read_input_tokens) {
        row.cache_read_input_tokens = (row.cache_read_input_tokens || 0) + usage.cache_read_input_tokens;
      }
      if (usage.cache_creation_input_tokens) {
        row.cache_creation_input_tokens = (row.cache_creation_input_tokens || 0) + usage.cache_creation_input_tokens;
      }
    };

    // Classification signals threaded through `complete()` calls, read after
    // ideateCore settles (or throws) to pick the most specific FAILURE_KINDS
    // value -- see the bottom of this method.
    // `abandoned` (issue #92): one record per batch this cell gave up waiting
    // on. Distinct from `timedOut` -- the flag says "a timeout happened", the
    // list says WHICH batch handle was surrendered, for how long it was
    // polled, and whether it was cancelled. That is the operator's recovery
    // path and the ledger's "we gave up" vs "the API failed" discriminator.
    const classification = { transportError: false, rateLimited: false, timedOut: false, abandoned: [] };

    // Per-cell reply diagnostics (issue #93). One record per model reply --
    // stop_reason, output tokens, what parsing did, a bounded raw snippet --
    // so a failed cell can say WHICH of "nothing came back" / "cut off" /
    // "complete but unparseable" happened. See the module header.
    const diagnostics = [];

    // max_tokens sized from what this arm actually asks for (issue #93 cause
    // 1). Arm A asks for 30 ideas in one call and was riding the old flat
    // 2048 cap; panel arms ask for 6 and compute below the retained 2048
    // floor, so their requests are unchanged. See prompts.mjs.
    const cellMaxTokens = maxTokensForCell(agents);

    const ctx = {
      addUsage,
      classification,
      diagnostics,
      cellMaxTokens,
      // ── Resume state (#103) ────────────────────────────────────────────
      resumeEnabled,
      // customId -> {model, text, stopReason, usage}. Seeded from the durable
      // record, grown by every reply this invocation receives or recovers.
      replay: state.replies,
      // Durable batch handles not yet fully recovered.
      outstanding: state.outstanding,
      // Per-CELL occurrence counter behind contentCustomId -- see there for
      // why per-cell and not per-batch.
      customIdCounts: new Map(),
      replayHits: 0,
    };
    const complete = mode === "single" ? (req) => this.#completeSingle(req, ctx) : (req) => this.#completeBatched(req, ctx);

    // ── Re-poll before re-spending (#103) ───────────────────────────────────
    // Done BEFORE the engine is re-entered, so every reply this cell has
    // already paid for is in `ctx.replay` by the time the first `complete()`
    // call is made and can be served for free. Recovery meters what it pulls
    // down (see #recoverOutstanding), which is also what finally writes a
    // previously-abandoned batch's spend into the ledger -- the residual
    // threat named in docs/PREREGISTRATION.md Appendix B item 4, exception 1.
    if (resumeEnabled && ctx.outstanding.length) {
      await this.#recoverOutstanding(ctx);
    }

    let ideateResult;
    try {
      ideateResult = await this.ideateImpl(
        { context: { slug: cell.briefId, brief: brief.text } },
        {
          complete,
          buildRound1Prompt,
          buildRound2Prompt,
          agents,
          maxRounds,
          onAgentError: (err, ctx) => {
            this.logger(`AnthropicBatchProvider: agent error (round ${ctx && ctx.round}, agent ${ctx && ctx.agentId}): ${err && err.message}`);
          },
        },
      );
    } catch (err) {
      // ideate-core's own contract is "never throw" (robustness over
      // strictness -- it swallows per-agent failures), so reaching this catch
      // means something OUTSIDE that contract broke: a transport error our
      // own `complete()` failed to swallow, or a genuine harness bug. Prefer
      // the most specific classification we detected along the way.
      return {
        terminalState: "failed",
        failureKind: pickFailureKind(classification, "transport_error"),
        detail: truncateDetail(abandonPrefix(classification, "AnthropicBatchProvider") + `AnthropicBatchProvider: ideateImpl threw: ${err && err.message}`),
        tokens: { tokens_by_model: tokensByModel },
        diagnostics,
      };
    }

    const candidates = (ideateResult && ideateResult.candidates) || [];

    // ── A PARTIAL pool after an abandoned batch is not a measurement (#92) ───
    // Panel arms run panel.maxRounds (2) rounds. If round 1's batch returns
    // and round 2's blows the ceiling, ideate-core still resolves cleanly with
    // round 1's candidates -- so without this branch the cell would store as
    // `completed` carrying a SILENTLY TRUNCATED pool, under-reporting distinct_k
    // for exactly the panel arms H1 compares against solo. That is the silent
    // pooling lib/manifest.mjs exists to prevent, arriving through the runner
    // instead. A pool assembled while we were still waiting on a batch we paid
    // for is classified `timeout` (transient, per #90): the cell is re-planned
    // next invocation and its spend is preserved under the attempt key.
    //
    // Deliberately scoped to ABANDONMENT, not to every partial: a round that
    // partially rate-limited is the same defect class but a wider decision than
    // #92 -- see the PR body, which names it rather than silently widening here.
    if (candidates.length > 0 && classification.abandoned.length > 0) {
      return {
        terminalState: "failed",
        failureKind: "timeout",
        detail: truncateDetail(
          abandonPrefix(classification, "AnthropicBatchProvider") +
            `discarding a PARTIAL pool of ${candidates.length} candidate(s) assembled from the rounds that did finish -- ` +
            "storing it would silently under-report this cell's pool size",
        ),
        tokens: { tokens_by_model: tokensByModel },
        diagnostics,
      };
    }

    if (candidates.length === 0) {
      // IC-08 silent mode: ideateCore resolved cleanly (no throw) but the
      // pool is empty. Since #93 this is no longer one undifferentiated
      // bucket: classifyPoolFailure reads the per-reply diagnostics and
      // distinguishes truncated / unparseable-but-complete / refused /
      // genuinely-empty, emitting the discriminator in `detail` (the only
      // field that reaches the ledger for a failed cell). Transport-level
      // signals still win over all of it via pickFailureKind.
      const allRefused = !!(
        ideateResult &&
        ideateResult.meta &&
        ideateResult.meta.agentsFailed === ideateResult.meta.agentsAttempted
      );
      const pool = classifyPoolFailure(diagnostics, { providerName: "AnthropicBatchProvider", allRefused });
      return {
        terminalState: "failed",
        failureKind: pickFailureKind(classification, pool.kind),
        detail: truncateDetail(abandonPrefix(classification, "AnthropicBatchProvider") + pool.detail),
        tokens: { tokens_by_model: tokensByModel },
        diagnostics,
      };
    }

    // ── An UNDERSIZED pool is not a measurement (issue #102) ──────────────────
    // See "THE UNDERSIZED-POOL RULE" above classifyUndersizedPool for the rule,
    // its two detection channels, the alternatives rejected, and why the
    // denominator is ideate-core's own counts rather than arm.slots.length.
    //
    // Placed AFTER the empty-pool branch on purpose: an all-agents-failed cell
    // must keep reaching classifyPoolFailure's `allRefused` path, which is the
    // pre-#93 `refusal` behaviour that branch's own comment says is preserved.
    // This branch therefore only ever sees a pool that is non-empty and short.
    const undersized = classifyUndersizedPool(ideateResult, diagnostics, {
      providerName: "AnthropicBatchProvider",
      candidateCount: candidates.length,
    });
    if (undersized) {
      return {
        terminalState: "failed",
        failureKind: pickFailureKind(classification, undersized.kind),
        detail: truncateDetail(abandonPrefix(classification, "AnthropicBatchProvider") + undersized.detail),
        tokens: { tokens_by_model: tokensByModel },
        diagnostics,
        meta: ideateResult.meta,
      };
    }

    return {
      terminalState: "completed",
      result: { candidates, agents: ideateResult.agents, meta: ideateResult.meta },
      tokens: { tokens_by_model: tokensByModel },
      diagnostics,
    };
  }

  // ── single mode: POST /v1/messages directly, resolve immediately ─────────
  async #completeSingle(req, { addUsage, classification, diagnostics, cellMaxTokens }) {
    const params = buildAnthropicMessageParams(withCellMaxTokens(req, cellMaxTokens));
    const { ok, status, json, error, errorBody } = await anthropicFetchWithRetry(
      this.fetchImpl,
      "https://api.anthropic.com/v1/messages",
      anthropicHeaders(this.apiKey),
      params,
      { maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!ok) {
      classifyTransportOutcome(status, error, classification, errorBody);
      return { ok: false };
    }
    addUsage(req.model, json.usage);
    return handleReplyText({
      model: req.model,
      stopReason: json && json.stop_reason,
      usage: json && json.usage,
      text: extractAnthropicText(json),
      diagnostics,
    });
  }

  // ── batch mode: buffer this call; flush the whole round as one batch ─────
  #completeBatched(req, ctx) {
    // Params are built HERE rather than in #flush so the content-derived
    // custom_id exists before the request is buffered -- which is what lets a
    // replay hit resolve without ever reaching a batch at all.
    const params = buildAnthropicMessageParams(withCellMaxTokens(req, ctx.cellMaxTokens));
    const customId = ctx.resumeEnabled ? contentCustomId(params, ctx.customIdCounts) : null;

    // ── Replay hit: this exact request was already answered and paid for ───
    // Checked BEFORE the post-abandonment short-circuit below: serving a
    // cached reply costs nothing and cannot extend the ceiling, so there is
    // no reason to withhold it from a cell that is already doomed -- and
    // letting it through keeps the diagnostics complete.
    //
    // Deliberately does NOT meter. A reply reaches `ctx.replay` only via
    // #recoverOutstanding (which meters at recovery) or via a durable record
    // written by the invocation that received and metered it. Metering here
    // as well is precisely the double count #103's AC4 names, and it would be
    // invisible: `spendToDate()` sums the cell record AND the
    // generation-attempt record that already carries these tokens.
    if (customId && Object.prototype.hasOwnProperty.call(ctx.replay, customId)) {
      const cached = ctx.replay[customId] || {};
      ctx.replayHits += 1;
      return Promise.resolve(
        handleReplyText({
          model: cached.model || req.model,
          stopReason: cached.stopReason,
          usage: cached.usage,
          text: cached.text,
          diagnostics: ctx.diagnostics,
        }),
      );
    }

    // Issue #92: once THIS cell has surrendered a batch at the ceiling it is
    // going to fail `timeout` no matter what the remaining rounds produce (see
    // the partial-pool guard in generate()). Panel arms run 2 rounds, so
    // without this short-circuit a cell that blew the ceiling in round 1 would
    // submit a SECOND batch and poll it for another full maxPollMs -- paying
    // real money for a pool the harness has already decided to discard, and
    // making the ceiling a per-batch rather than a per-cell bound. Resolve
    // immediately with the same failure the abandonment produced.
    if (ctx && ctx.classification && (ctx.classification.abandoned || []).length > 0) {
      return Promise.resolve({ ok: false, __failureKind: "timeout" });
    }
    return new Promise((resolve, reject) => {
      this.#pending.push({ req, params, customId, resolve, reject, ctx });
      if (!this.#flushScheduled) {
        this.#flushScheduled = true;
        // Subsequent-macrotask debounce: every agent's complete() call for
        // this round is already queued (they were all fired synchronously by
        // ideate-core's Promise.all) by the time a setTimeout(fn, 0) callback
        // runs, because a macrotask never runs before the current + already
        // queued microtasks drain.
        setTimeout(() => this.#flush(), 0);
      }
    });
  }

  /**
   * Surrender an in-flight batch at the poll ceiling (issue #92): cancel it so
   * it does not bill unattended, log the durable handle so the operator can
   * re-poll or cancel by hand, record the abandonment on every waiting cell's
   * classification (the ledger discriminator), and resolve every buffered
   * `complete()` as `timeout` -- a TRANSIENT kind, so #90 re-plans the cell.
   */
  async #abandon(batch, batchId, startedAt, lastStatus, submittedAt) {
    const elapsedMs = Date.now() - startedAt;
    const cancelled = this.cancelOnAbandon
      ? await cancelBatchQuietly(
          this.fetchImpl,
          `https://api.anthropic.com/v1/messages/batches/${batchId}/cancel`,
          anthropicHeaders(this.apiKey),
          { sleep: this.sleep, logger: this.logger },
        )
      : null;
    this.logger(
      `AnthropicBatchProvider: poll ceiling reached after ${elapsedMs}ms (maxPollMs=${this.maxPollMs}) -- abandoning batch ${batchId}. ` +
        (cancelled === null
          ? "cancelOnAbandon is off, so it was left running."
          : cancelled === true
            ? "It was cancelled so it will not bill unattended."
            : `The cancel call did not succeed (${cancelled}) -- it may still bill; cancel by hand: POST /v1/messages/batches/${batchId}/cancel.`) +
        ` The handle is durable: GET /v1/messages/batches/${batchId} still reports it.`,
    );
    // ONE record shared by every cell waiting on this batch (in practice one
    // cell per flush, since generate() drives ideate-core to completion before
    // the next cell starts -- but the barrier-batcher makes no such promise).
    const record = { batchId, elapsedMs, maxPollMs: this.maxPollMs, lastStatus: lastStatus || null, cancelled };
    for (const ctx of new Set(batch.map((entry) => entry.ctx))) {
      ctx.classification.timedOut = true;
      if (!Array.isArray(ctx.classification.abandoned)) ctx.classification.abandoned = [];
      ctx.classification.abandoned.push(record);
      // ── Hand the handle to resume, per cell (#103) ───────────────────────
      // #92 already made the id reachable (the log line, the ledger detail) so
      // it was never lost -- but nothing could act on it. `submitToCustom` is
      // what makes acting on it possible: results come back keyed by the id we
      // SUBMITTED under, and the cache is keyed by the CONTENT id. Those are
      // the same string except in the one case where a single flush spanned
      // two cells and #flush had to disambiguate (see there).
      if (!ctx.resumeEnabled) continue;
      const submitToCustom = {};
      for (const entry of batch) {
        if (entry.ctx !== ctx || !entry.customId) continue;
        // The MODEL is recorded alongside the content id, not left to be read
        // off the recovered message. `addUsage(model, usage)` is a silent
        // no-op when `model` is falsy -- so a recovery that leaned on the
        // reply's own `model` field would drop real, already-billed tokens on
        // the floor for any response shape that omits it, and drop them
        // invisibly. What we SUBMITTED is the authoritative answer to "which
        // model was this billed against" and it is known here, for free.
        submitToCustom[entry.submitId] = { customId: entry.customId, model: entry.req && entry.req.model };
      }
      ctx.outstanding.push({
        provider: "anthropic",
        batchId,
        submittedAt: submittedAt || new Date().toISOString(),
        cancelled,
        submitToCustom,
      });
    }
    for (const entry of batch) entry.resolve({ ok: false, __failureKind: "timeout" });
  }

  /**
   * Re-poll every durable handle this cell surrendered in an earlier session
   * and fold whatever the provider still has into `ctx.replay` (#103).
   *
   * Every exit drops the handle EXCEPT "the batch is still genuinely running"
   * and "the poll itself failed transiently" -- a handle that is kept is one
   * that can still pay off later, and a handle that is dropped is one that
   * degrades to a fresh submit (#103 AC6) rather than to an error.
   */
  async #recoverOutstanding(ctx) {
    const kept = [];
    for (const handle of ctx.outstanding) {
      if (!handle || handle.provider !== "anthropic" || !handle.batchId) continue;
      // Anthropic keeps results downloadable for 29 days after batch creation
      // (verified 2026-09-02). Past that the GET would 404 or return a batch
      // with no results_url; skip the network call rather than spend a
      // retry budget discovering it.
      if (batchResultsExpired(handle.submittedAt, ANTHROPIC_RESULTS_RETENTION_MS)) {
        this.logger(
          `AnthropicBatchProvider: batch ${handle.batchId} is past the documented ${ANTHROPIC_RESULTS_RETENTION_DAYS}-day results retention ` +
            "(submitted " + handle.submittedAt + ") -- dropping the handle and re-submitting these requests fresh.",
        );
        continue;
      }
      const kept0 = await this.#recoverOneAnthropicBatch(ctx, handle);
      if (kept0) kept.push(handle);
    }
    ctx.outstanding.length = 0;
    ctx.outstanding.push(...kept);
  }

  /** @returns {Promise<boolean>} true to KEEP the handle for a later attempt. */
  async #recoverOneAnthropicBatch(ctx, handle) {
    const url = `https://api.anthropic.com/v1/messages/batches/${handle.batchId}`;
    const headers = anthropicHeaders(this.apiKey);
    const startedAt = Date.now();
    const deadline = startedAt + this.maxPollMs;

    let poll = await anthropicFetchWithRetry(this.fetchImpl, url, headers, undefined, {
      method: "GET",
      maxRetries: this.maxRetries,
      sleep: this.sleep,
      logger: this.logger,
    });
    if (!poll.ok) {
      // 404/410: the handle is gone for good (deleted, or past retention).
      // Drop it -- AC6's "an expired handle degrades to a fresh submit rather
      // than an error". Anything else may be transient, so keep it: a kept
      // handle costs one GET next time and can still pay off.
      const gone = poll.status === 404 || poll.status === 410;
      this.logger(
        `AnthropicBatchProvider: could not re-poll batch ${handle.batchId} (status ${poll.status}) -- ` +
          (gone ? "the handle is gone; re-submitting these requests fresh." : "keeping the handle for a later attempt."),
      );
      return !gone;
    }

    while (poll.json.processing_status !== "ended") {
      if (Date.now() > deadline) {
        // Re-abandonment, and deliberately a CHEAP one: marking the cell
        // abandoned makes #completeBatched short-circuit every subsequent
        // request, so this attempt costs one poll loop and zero new tokens
        // rather than re-running the whole cell against a fresh batch.
        this.logger(
          `AnthropicBatchProvider: resumed batch ${handle.batchId} is still ${poll.json.processing_status} after ${Date.now() - startedAt}ms ` +
            `(maxPollMs=${this.maxPollMs}) -- surrendering again without submitting anything new. The handle is retained.`,
        );
        ctx.classification.timedOut = true;
        if (!Array.isArray(ctx.classification.abandoned)) ctx.classification.abandoned = [];
        ctx.classification.abandoned.push({
          batchId: handle.batchId,
          elapsedMs: Date.now() - startedAt,
          maxPollMs: this.maxPollMs,
          lastStatus: poll.json.processing_status,
          cancelled: null,
          resumed: true,
        });
        return true;
      }
      await this.sleep(this.pollIntervalMs);
      poll = await anthropicFetchWithRetry(this.fetchImpl, url, headers, undefined, {
        method: "GET",
        maxRetries: this.maxRetries,
        sleep: this.sleep,
        logger: this.logger,
      });
      if (!poll.ok) return poll.status !== 404 && poll.status !== 410;
    }

    const resultsUrl = poll.json.results_url;
    if (!resultsUrl) {
      // An ended batch with no results_url has nothing left to give. Observed
      // shape for an expired batch; also the honest fallback for a cancelled
      // batch whose results the API declines to expose.
      this.logger(`AnthropicBatchProvider: batch ${handle.batchId} ended with no results_url -- nothing to recover; re-submitting fresh.`);
      return false;
    }
    const results = await anthropicFetchWithRetry(this.fetchImpl, resultsUrl, headers, undefined, {
      method: "GET",
      raw: true,
      maxRetries: this.maxRetries,
      sleep: this.sleep,
      logger: this.logger,
    });
    if (!results.ok) {
      this.logger(`AnthropicBatchProvider: batch ${handle.batchId} ended but its results download failed (status ${results.status}) -- keeping the handle.`);
      return true;
    }

    let recovered = 0;
    for (const line of results.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const mapped = (handle.submitToCustom || {})[row.custom_id];
      const customId = mapped && mapped.customId;
      if (!customId) continue;
      // ONLY `succeeded` carries a reply, and only `succeeded` was billed:
      // `errored`, `canceled` and `expired` are all documented as not billed,
      // so there is nothing to meter and nothing to cache for them. They are
      // simply re-issued, which is exactly the partial-recovery case that
      // makes cancel-on-abandon and resume complements.
      if (!row.result || row.result.type !== "succeeded") continue;
      const message = row.result.message;
      const model = mapped.model || (message && message.model) || null;
      // METERED HERE, at recovery -- not when the reply is later served. A
      // reply we pulled down but the engine never asks for is still money the
      // provider charged; metering on serve would silently drop it, and this
      // is the write that closes docs/PREREGISTRATION.md Appendix B item 4's
      // exception 1 for a batch that is ever re-polled.
      ctx.addUsage(model, message && message.usage);
      ctx.replay[customId] = {
        model,
        text: extractAnthropicText(message),
        stopReason: message && message.stop_reason,
        usage: (message && message.usage) || null,
      };
      recovered += 1;
    }
    this.logger(
      `AnthropicBatchProvider: recovered ${recovered} already-paid-for repl${recovered === 1 ? "y" : "ies"} from batch ${handle.batchId} ` +
        "-- these will be replayed instead of re-submitted.",
    );
    return false;
  }

  async #flush() {
    const batch = this.#pending;
    this.#pending = [];
    this.#flushScheduled = false;
    if (!batch.length) return;

    // custom_ids are CONTENT-DERIVED as of #103 and computed in
    // #completeBatched, before buffering -- see contentCustomId. The random
    // suffix they replaced was unique within a batch and meaningless outside
    // it, which is exactly why no persisted reply could ever be matched back
    // to a re-issued request.
    //
    // `submitId` vs `customId`: identical except when ONE flush spans TWO
    // cells whose requests serialize identically (two replicates of the same
    // arm+brief). The content id is then the same string for both, and
    // Anthropic requires uniqueness within a batch. The runner drives cells
    // sequentially so this does not arise today, but the barrier-batcher makes
    // no such promise -- so the SUBMITTED id is disambiguated while the CACHE
    // id stays content-derived. The cache is per-cell, so two cells sharing a
    // content id is not a cache collision.
    const seenSubmitIds = new Set();
    const requests = batch.map((entry, i) => {
      const params = entry.params || buildAnthropicMessageParams(withCellMaxTokens(entry.req, entry.ctx.cellMaxTokens));
      let submitId = entry.customId || `req-${i}-${Math.random().toString(36).slice(2, 8)}`;
      for (let n = 1; seenSubmitIds.has(submitId); n += 1) submitId = `${entry.customId}_${n}`;
      seenSubmitIds.add(submitId);
      entry.submitId = submitId;
      return { custom_id: submitId, params };
    });
    const byCustomId = new Map(requests.map((r, i) => [r.custom_id, batch[i]]));

    const submit = await anthropicFetchWithRetry(
      this.fetchImpl,
      "https://api.anthropic.com/v1/messages/batches",
      anthropicHeaders(this.apiKey),
      { requests },
      { maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!submit.ok) {
      // NB (issue #88): the second argument is the response BODY, never
      // `submit.error` (which is a thrown fetch Error, not a body) -- feeding
      // an Error to the billing sniffer would be a category mistake.
      const kind = classifyTransportKind(submit.status, submit.errorBody);
      for (const entry of batch) {
        classifyTransportOutcome(submit.status, submit.error, entry.ctx.classification, submit.errorBody);
        entry.resolve({ ok: false, __failureKind: kind });
      }
      return;
    }

    const batchId = submit.json.id;
    const startedAt = Date.now();
    // The submission wall-clock, kept separate from `startedAt` (a monotonic-ish
    // poll origin) because it is what the 29-day results-retention check reads
    // in a LATER process. Prefer the provider's own `created_at`.
    const submittedAt = submit.json.created_at || new Date().toISOString();
    const deadline = startedAt + this.maxPollMs;
    // `batchStatus` tracks the most recently observed batch object (submit's
    // response initially, then each poll's) so "ended" can be detected
    // whether it happens on the submit response itself (a trivially fast
    // batch, e.g. in a test) or only after one or more polls.
    let batchStatus = submit.json;

    while (batchStatus.processing_status !== "ended") {
      if (Date.now() > deadline) {
        await this.#abandon(batch, batchId, startedAt, batchStatus.processing_status, submittedAt);
        return;
      }
      await this.sleep(this.pollIntervalMs);
      const poll = await anthropicFetchWithRetry(
        this.fetchImpl,
        `https://api.anthropic.com/v1/messages/batches/${batchId}`,
        anthropicHeaders(this.apiKey),
        undefined,
        { method: "GET", maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
      );
      if (!poll.ok) {
        for (const entry of batch) {
          classifyTransportOutcome(poll.status, poll.error, entry.ctx.classification, poll.errorBody);
          entry.resolve({ ok: false, __failureKind: classifyTransportKind(poll.status, poll.errorBody) });
        }
        return;
      }
      batchStatus = poll.json;
    }

    const resultsUrl = batchStatus.results_url;
    const results = await anthropicFetchWithRetry(
      this.fetchImpl,
      resultsUrl,
      anthropicHeaders(this.apiKey),
      undefined,
      { method: "GET", raw: true, maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!results.ok) {
      for (const entry of batch) {
        classifyTransportOutcome(results.status, results.error, entry.ctx.classification, results.errorBody);
        entry.resolve({ ok: false, __failureKind: classifyTransportKind(results.status, results.errorBody) });
      }
      return;
    }

    // JSONL: one result line per custom_id, arbitrary order -- key by
    // custom_id, never by array position (spec + AC requirement).
    const seen = new Set();
    for (const line of results.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue; // a malformed JSONL line is a per-result transport hiccup, not a whole-batch failure
      }
      const entry = byCustomId.get(row.custom_id);
      if (!entry) continue; // unknown custom_id -- ignore rather than crash
      seen.add(row.custom_id);

      if (row.result && row.result.type === "succeeded") {
        const message = row.result.message;
        entry.ctx.addUsage(entry.req.model, message && message.usage);
        const text = extractAnthropicText(message);
        // Cache under the CONTENT id (#103). Every reply this cell receives is
        // remembered, not only the ones from a batch that later gets
        // abandoned: a panel cell that finished round 1 and then blew the
        // ceiling on round 2 has no outstanding handle for round 1 at all, and
        // without this line the resumed attempt would re-issue and re-pay for
        // round 1 in order to reach round 2's recoverable batch.
        if (entry.ctx.resumeEnabled && entry.customId) {
          entry.ctx.replay[entry.customId] = {
            model: entry.req.model,
            text,
            stopReason: message && message.stop_reason,
            usage: (message && message.usage) || null,
          };
        }
        entry.resolve(
          handleReplyText({
            model: entry.req.model,
            stopReason: message && message.stop_reason,
            usage: message && message.usage,
            text,
            diagnostics: entry.ctx.diagnostics,
          }),
        );
      } else if (row.result && row.result.type === "errored") {
        const err = row.result.error || {};
        // A per-row error carries the same `{type, message}` shape as a
        // top-level one, so a credit refusal can surface HERE too (a batch
        // submitted while funded whose rows are processed after the balance
        // hits zero). Wrap it in the `{error: ...}` envelope isBillingRefusal
        // reads (issue #88).
        if (isBillingRefusal(undefined, { error: err })) entry.ctx.classification.paymentRequired = true;
        else if (err.type === "rate_limit_error") entry.ctx.classification.rateLimited = true;
        else entry.ctx.classification.transportError = true;
        entry.resolve({
          ok: false,
          __failureKind: isBillingRefusal(undefined, { error: err })
            ? "payment_required"
            : err.type === "rate_limit_error"
              ? "rate_limited"
              : "transport_error",
        });
      } else {
        // "canceled" / "expired" / anything else Anthropic might add later --
        // treat as a transport-classified failure for this entry, never throw.
        entry.ctx.classification.transportError = true;
        entry.resolve({ ok: false, __failureKind: "transport_error" });
      }
    }
    // Any request that never got a matching result line (should not happen
    // per the API contract, but robustness over strictness applies here too)
    // resolves as a transport error rather than hanging forever.
    for (const [customId, entry] of byCustomId) {
      if (!seen.has(customId)) {
        entry.ctx.classification.transportError = true;
        entry.resolve({ ok: false, __failureKind: "transport_error" });
      }
    }
  }
}

// ── Arm -> ideate-core invocation mapping (spec item: "map arms to real
// ideate-core calls") ────────────────────────────────────────────────────────
//
// Solo (arm.mode === "solo", i.e. Arm A): ONE agent, `agentCount` 1,
// `maxRounds: 1` (no build-on round -- matched on total ideas requested, not
// on panel shape). Panel: one agent per slot, `armsConfig.panel.ideasPerAgent`
// / `armsConfig.panel.maxRounds` held constant across every panel arm (per
// arms.config.json's own top-level comment).
export function resolveIdeateAgents(arm, armsConfig) {
  if (!arm) throw new Error("resolveIdeateAgents: arm is required");
  if (arm.mode === "solo") {
    const slot = (arm.slots && arm.slots[0]) || {};
    return {
      agents: [{ id: slot.persona || "solo", persona: slot.persona, model: slot.model, ideasPerAgent: arm.totalIdeasRequested }],
      maxRounds: 1,
    };
  }
  const panel = (armsConfig && armsConfig.panel) || {};
  const slots = arm.slots || [];
  return {
    agents: slots.map((slot, i) => ({
      id: `${slot.persona}#${i}`,
      persona: slot.persona,
      model: slot.model,
      ideasPerAgent: panel.ideasPerAgent,
    })),
    maxRounds: panel.maxRounds,
  };
}

/**
 * Apply the cell's computed max_tokens floor to a request ideate-core built
 * (issue #93). ideate-core does not supply a `maxTokens` today -- which is why
 * every #8 call went out at `?? 2048` -- but if a future version does, the
 * LARGER of the two wins, so this floor can never silently shrink a request
 * the engine deliberately sized.
 *
 * Deliberately applied HERE, at the call site, rather than inside
 * buildAnthropicMessageParams / buildOpenAIChatParams: those two builders keep
 * their existing contract ("an explicit req.maxTokens is honoured verbatim"),
 * which is what makes their force-strip allowlist easy to audit against
 * docs/PREREGISTRATION.md §3.3.
 */
export function withCellMaxTokens(req, cellMaxTokens) {
  if (!Number.isFinite(cellMaxTokens) || cellMaxTokens <= 0) return req;
  return { ...req, maxTokens: Math.max(req && Number.isFinite(req.maxTokens) ? req.maxTokens : 0, cellMaxTokens) };
}

// ── Force-strip sampling params BY CONSTRUCTION (docs/PREREGISTRATION.md
// §3.3) ──────────────────────────────────────────────────────────────────────
//
// ideate-core@0.4.0 ships `modelAcceptsSamplingParams` at
// ideate-core/integrations/sampling-params, which returns `true` for Haiku
// (Haiku still accepts temperature/top_p/top_k) -- using that helper
// unmodified would keep the diversity lever the pre-registration explicitly
// says was removed for THIS study, and would INVERT the registered bias
// direction (§3.3: "strip universally ... if the haiku arms still win on
// diversity, they did so with one lever disabled"). So this adapter never
// calls that helper at all: `buildAnthropicMessageParams` simply never reads
// `req.temperature` / `req.top_p` / `req.top_k` for ANY model, Haiku
// included -- the params object is built field-by-field from an explicit
// allowlist, so there is no code path that could carry a sampling param
// through even by accident (as opposed to a strip-after-the-fact `delete`,
// which a future edit could bypass by constructing params a different way).
export function buildAnthropicMessageParams(req) {
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 2048,
    messages: [{ role: "user", content: req.prompt }],
    // Deliberately no temperature / top_p / top_k, for any model. See above.
  };
}

// ── Shared Anthropic transport, exported for reuse by the judge scorer (#21) ──
// evals/judge/score.mjs implements the judge's LIVE scoring call and, per that
// issue ("reuse the generation adapter's provider interface and its batch path
// where possible"), drives the SAME Anthropic Messages / Message Batches
// transport this adapter uses rather than duplicating headers, retry/backoff,
// text extraction, and failure classification. These helpers are pure and
// stateless (no `this`), so exporting them is additive — the generation path is
// unchanged, and there is exactly one implementation of "how this repo talks to
// the Anthropic API" for both generation and judging.
export function anthropicHeaders(apiKey) {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

/** Concatenate the `text` of every text content block in an Anthropic message. */
export function extractAnthropicText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * fetchImpl wrapper with minimal retry/backoff on 429 / 5xx, using the
 * injected `sleep` so tests run instantly. Never throws -- always resolves to
 * `{ ok: true, json }` (or `{ ok: true, text }` when `raw` is requested, for
 * the JSONL results download) or `{ ok: false, status, error }`.
 */
export async function anthropicFetchWithRetry(fetchImpl, url, headers, body, { method = "POST", raw = false, maxRetries = 3, sleep, logger } = {}) {
  let lastStatus;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // A rejected fetch (DNS failure, connection reset, etc.) -- retry like
      // any other transient transport failure, never throw out of this
      // helper.
      lastError = err;
      lastStatus = undefined;
      if (attempt < maxRetries) {
        if (logger) logger(`anthropicFetchWithRetry: fetch rejected (attempt ${attempt + 1}/${maxRetries + 1}): ${err && err.message}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      return { ok: false, status: undefined, error: err };
    }

    if (res.ok) {
      return raw ? { ok: true, text: await res.text() } : { ok: true, json: await res.json() };
    }

    lastStatus = res.status;
    // issue #88: read the body BEFORE deciding whether to retry. A billing
    // refusal can arrive on a status that is otherwise retryable (OpenAI's
    // quota exhaustion is a 429), and burning the full backoff ladder against
    // an account that cannot pay is exactly the futile retry this fixes.
    const errorBody = await readErrorBody(res);
    const billing = isBillingRefusal(res.status, errorBody);
    const retryable = !billing && (res.status === 429 || res.status >= 500);
    if (retryable && attempt < maxRetries) {
      if (logger) logger(`anthropicFetchWithRetry: HTTP ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying`);
      await sleep(backoffMs(attempt));
      continue;
    }
    if (billing && logger) logger(`anthropicFetchWithRetry: HTTP ${res.status} is a billing/credit refusal -- not retrying`);
    return { ok: false, status: res.status, error: undefined, errorBody };
  }
  return { ok: false, status: lastStatus, error: lastError };
}

/**
 * Best-effort read of a non-ok response's body (issue #88), so
 * `isBillingRefusal()` has a signature to key on. A `Response` body is
 * single-use, so exactly ONE read path is taken: `text()` when it exists
 * (then parsed as JSON if it parses), otherwise `json()`.
 *
 * Never throws and never rejects: a fake fetch with neither method, a body
 * already consumed, a truncated stream — all answer `undefined`, and the
 * caller falls back to status-only classification exactly as before. Making a
 * diagnostic read able to break a request would be a worse bug than the one
 * it exists to fix.
 */
async function readErrorBody(res) {
  try {
    if (res && typeof res.text === "function") {
      const text = await res.text();
      if (typeof text !== "string" || text === "") return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (res && typeof res.json === "function") return await res.json();
  } catch {
    // fall through
  }
  return undefined;
}

function backoffMs(attempt) {
  return 2 ** attempt * 100; // 100ms, 200ms, 400ms, ... -- tests inject a no-op sleep so this never actually delays a test
}

// ── Billing / credit refusals (issue #88) ──────────────────────────────
//
// "The account cannot pay" arrives wearing an ordinary HTTP status. Observed
// live 2026-09-02 on POST /v1/messages/batches (request_id
// req_011CeejUhYyYfutJc9YTHFnd):
//
//   HTTP 400
//   {"type":"error","error":{"type":"invalid_request_error",
//    "message":"Your credit balance is too low to access the Anthropic API.
//               Please go to Plans & Billing to upgrade or purchase credits."},
//    "request_id":"req_011CeejUhYyYfutJc9YTHFnd"}
//
// 400 is far too overloaded to key on — a malformed request, an oversized
// max_tokens and an unfunded account all land there — so detection reads the
// response BODY's error signature. That is also why both fetch helpers below
// now capture `errorBody` on a non-ok response: without it there is nothing to
// key on and the refusal is indistinguishable from a 5xx.

/** Lowercased message text out of an Anthropic- or OpenAI-shaped error body. */
function errorBodyMessage(body) {
  if (typeof body === "string") return body.toLowerCase();
  if (!body || typeof body !== "object") return "";
  const err = body.error;
  const msg = err && typeof err === "object" ? err.message : body.message;
  return typeof msg === "string" ? msg.toLowerCase() : "";
}

/** Lowercased `error.type` / `error.code` out of an error body, as one string. */
function errorBodyCodes(body) {
  if (!body || typeof body !== "object") return "";
  const err = body.error;
  if (!err || typeof err !== "object") return "";
  return [err.type, err.code].filter((v) => typeof v === "string").join(" ").toLowerCase();
}

/**
 * True when a failed response is the provider saying "this account cannot pay".
 *
 * Keyed on the body, never on `status` alone. Deliberately tolerant of junk
 * input (an `Error` from a rejected fetch, a `undefined` body from a helper
 * that could not read one, a raw text body) — every one of those answers
 * `false` rather than throwing, because a detector that can crash the
 * classifier is worse than the misclassification it exists to fix.
 *
 * @param {number|undefined} status
 * @param {object|string|undefined} errorBody parsed JSON body, or raw text
 */
export function isBillingRefusal(status, errorBody) {
  if (errorBody instanceof Error) return false;
  const message = errorBodyMessage(errorBody);
  const codes = errorBodyCodes(errorBody);

  // ── Anthropic: CAPTURE-VERIFIED against the response quoted above. ──────
  // `invalid_request_error` + a credit/billing message. Matching the message
  // (not the type, which is generic) is what keeps an ordinary malformed-body
  // 400 out of this bucket.
  if (/credit balance is too low/.test(message)) return true;
  if (/plans\s*&\s*billing/.test(message)) return true;

  // ── OpenAI: DOCUMENTATION-DERIVED, NOT capture-verified. ────────────────
  // No OpenAI quota-exhaustion response has been captured from this harness,
  // and nothing in this repo's results/ holds one. OpenAI documents the
  // condition as `type`/`code` `insufficient_quota` ("You exceeded your
  // current quota, please check your plan and billing details"), delivered
  // as HTTP **429** — which today classifies `rate_limited`, also transient,
  // so the same march-into-the-wall exists on that side through a different
  // door. This is the seam: if the real body turns out to differ, this is the
  // one function to correct, and the runner/accounting halves need no change.
  if (/insufficient_quota/.test(codes)) return true;
  if (/exceeded your current quota/.test(message)) return true;
  if (/check your plan and billing details/.test(message)) return true;

  return false;
}

/**
 * Mutate `classification` in place based on a failed fetch's status/error.
 * `errorBody` (issue #88) is the parsed response body when the helper could
 * read one; a billing refusal outranks every other signal.
 */
export function classifyTransportOutcome(status, error, classification, errorBody) {
  if (isBillingRefusal(status, errorBody)) classification.paymentRequired = true;
  else if (status === 429) classification.rateLimited = true;
  else classification.transportError = true;
}

/** Same signal as classifyTransportOutcome, but returned as a FAILURE_KINDS value. */
export function classifyTransportKind(status, errorBody) {
  if (isBillingRefusal(status, errorBody)) return "payment_required";
  return status === 429 ? "rate_limited" : "transport_error";
}

/**
 * Pick the most specific failure kind observed during this cell's calls,
 * falling back to `fallback` when nothing more specific was recorded.
 * Precedence: payment_required > timeout > rate_limited > transport_error >
 * fallback. `payment_required` outranks even `timeout` (issue #88): every
 * other flag describes the weather, while an unfunded account is the single
 * fact that explains the whole run and is the one the runner aborts on. A
 * cell that both blew the poll ceiling AND saw a credit refusal must report
 * the refusal, or the abort never fires.
 */
export function pickFailureKind(classification, fallback) {
  if (classification.paymentRequired) return "payment_required";
  if (classification.timedOut) return "timeout";
  if (classification.rateLimited) return "rate_limited";
  if (classification.transportError) return "transport_error";
  return fallback;
}

// ── OpenAIBatchProvider: the real OpenAI adapter (issue #22) ────────────────
//
// Makes arm H (homogeneous OpenAI) runnable and supplies the OpenAI generation
// path arm G (cross-provider) needs. Same interface contract as
// AnthropicBatchProvider — `{ mode }` in, `{ terminalState, result, tokens,
// failureKind? }` out, never throws for a transport failure — and the SAME
// barrier-batcher shape: ideate-core fires a round's N agents synchronously via
// Promise.all, so `#completeBatched` buffers each `complete(req)` and, on the
// first push, schedules `#flush()` on a subsequent macrotask, submitting the
// whole round as ONE OpenAI Batch. Every network/timer/engine seam is
// injectable with a live default, so evals/harness/openai-batch.test.mjs
// exercises this class with zero network and an empty node_modules.
//
// ── OpenAI Batches API differs from Anthropic's (a file, not an inline array) ──
//   1. POST /v1/files (multipart, purpose=batch) with a JSONL body, one line
//      per request { custom_id, method, url: "/v1/chat/completions", body }.
//   2. POST /v1/batches { input_file_id, endpoint, completion_window }.
//   3. Poll GET /v1/batches/{id} until status === "completed".
//   4. GET /v1/files/{output_file_id}/content -> JSONL, one line per custom_id
//      { custom_id, response: { status_code, body: { choices, usage } }, error }.
// Results are keyed by custom_id (never line position), same requirement as the
// Anthropic path.
//
// ── Force-strip by construction (§3.3), same as the Anthropic path ──────────
// buildOpenAIChatParams builds the request body field-by-field from an explicit
// allowlist (model, messages, max_completion_tokens) and NEVER reads
// temperature/top_p/top_k for any model — so a per-provider difference cannot
// reintroduce the confound the pre-registration eliminated.
export class OpenAIBatchProvider {
  /**
   * @param {object} [opts]  same seams as AnthropicBatchProvider.
   *   @param {string}   [opts.apiKey]      OPENAI_API_KEY; a missing key returns a
   *     classified harness_error on the first call rather than throwing.
   *   @param {Array}    [opts.corpus]      briefs; text looked up by cell.briefId.
   *   @param {object}   [opts.armsConfig]  parsed arms.config.json (panel shape).
   *   @param {typeof fetch} [opts.fetchImpl]
   *   @param {Function} [opts.ideateImpl]  live default dynamically imports ideate-core.
   *   @param {Function} [opts.sleep]       (ms)=>Promise; injectable for instant tests.
   *   @param {number}   [opts.pollIntervalMs]  (live default 2000ms)
   *   @param {number}   [opts.maxPollMs]       (live default DEFAULT_MAX_POLL_MS -- issue #92)
   *   @param {boolean}  [opts.cancelOnAbandon] cancel an in-flight batch at the ceiling (default true)
   *   @param {boolean}  [opts.resume]          issue #103: replay already-paid-for replies and
   *     re-poll an abandoned handle instead of re-submitting (default true, batch mode only)
   *   @param {number}   [opts.maxRetries]      (default 3)
   *   @param {(msg:string)=>void} [opts.logger]
   */
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    corpus = [],
    armsConfig,
    fetchImpl = globalThis.fetch,
    ideateImpl = async (...a) => (await import("ideate-core")).ideateCore(...a),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs = 2000,
    maxPollMs = DEFAULT_MAX_POLL_MS,
    cancelOnAbandon = true,
    resume = true,
    maxRetries = 3,
    logger = (msg) => console.error(msg),
  } = {}) {
    this.apiKey = apiKey;
    this.corpus = corpus;
    this.armsConfig = armsConfig;
    this.fetchImpl = fetchImpl;
    this.ideateImpl = ideateImpl;
    this.sleep = sleep;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPollMs = assertPollCeiling(maxPollMs, "OpenAIBatchProvider");
    this.cancelOnAbandon = cancelOnAbandon;
    this.resume = resume;
    this.maxRetries = maxRetries;
    this.logger = logger;
    this.#pending = [];
    this.#flushScheduled = false;
  }

  #pending;
  #flushScheduled;

  /** Same wrapper shape as AnthropicBatchProvider#generate -- see there. */
  async generate(cell, arm, opts = {}) {
    const mode = (opts && opts.mode) || "batch";
    const resumeEnabled = !!this.resume && mode === "batch";
    const state = normalizeResumeState(resumeEnabled ? opts.resume : null);
    const resp = await this.#generate(cell, arm, opts, state, resumeEnabled);
    return resumeEnabled ? { ...resp, resume: { replies: state.replies, outstanding: state.outstanding } } : resp;
  }

  async #generate(cell, arm, { mode = "batch" } = {}, state = { replies: {}, outstanding: [] }, resumeEnabled = false) {
    if (!this.apiKey) {
      return { terminalState: "failed", failureKind: "harness_error", detail: "OpenAIBatchProvider: no apiKey (OPENAI_API_KEY unset) -- refusing to call the network with no credential", tokens: { tokens_by_model: {} } };
    }
    const brief = this.corpus.find((b) => b.id === cell.briefId);
    if (!brief) {
      return { terminalState: "failed", failureKind: "harness_error", detail: `OpenAIBatchProvider: no corpus brief found for briefId '${cell.briefId}'`, tokens: { tokens_by_model: {} } };
    }

    const { agents, maxRounds } = resolveIdeateAgents(arm, this.armsConfig);
    const tokensByModel = {};
    const addUsage = (model, usage) => {
      if (!model || !usage) return;
      const row = (tokensByModel[model] = tokensByModel[model] || { input_tokens: 0, output_tokens: 0 });
      // OpenAI reports prompt_tokens / completion_tokens; map to the ledger's
      // input_tokens / output_tokens shape (lib/accounting.mjs costRow).
      row.input_tokens += usage.prompt_tokens || usage.input_tokens || 0;
      row.output_tokens += usage.completion_tokens || usage.output_tokens || 0;
    };
    // `abandoned` (issue #92) -- mirrored from the Anthropic path above.
    const classification = { transportError: false, rateLimited: false, timedOut: false, abandoned: [] };
    // Issue #93, mirrored from the Anthropic path above -- same diagnostics,
    // same max_tokens sizing. Arm H (homogeneous OpenAI) and arm G's OpenAI
    // slots were never exercised by the #8 smoke study, but they have exactly
    // the same shape, so they get exactly the same fix rather than waiting to
    // reproduce the bug on a second provider.
    const diagnostics = [];
    const cellMaxTokens = maxTokensForCell(agents);
    // Resume state (#103), mirrored from the Anthropic path -- see the BATCH
    // RESUME section near the top of this file for the whole design.
    const ctx = {
      addUsage,
      classification,
      diagnostics,
      cellMaxTokens,
      resumeEnabled,
      replay: state.replies,
      outstanding: state.outstanding,
      customIdCounts: new Map(),
      replayHits: 0,
    };

    const complete = mode === "single" ? (req) => this.#completeSingle(req, ctx) : (req) => this.#completeBatched(req, ctx);

    if (resumeEnabled && ctx.outstanding.length) {
      await this.#recoverOutstanding(ctx);
    }

    let ideateResult;
    try {
      ideateResult = await this.ideateImpl(
        { context: { slug: cell.briefId, brief: brief.text } },
        {
          complete,
          buildRound1Prompt,
          buildRound2Prompt,
          agents,
          maxRounds,
          onAgentError: (err, ctx) => {
            this.logger(`OpenAIBatchProvider: agent error (round ${ctx && ctx.round}, agent ${ctx && ctx.agentId}): ${err && err.message}`);
          },
        },
      );
    } catch (err) {
      return { terminalState: "failed", failureKind: pickFailureKind(classification, "transport_error"), detail: truncateDetail(abandonPrefix(classification, "OpenAIBatchProvider") + `OpenAIBatchProvider: ideateImpl threw: ${err && err.message}`), tokens: { tokens_by_model: tokensByModel }, diagnostics };
    }

    const candidates = (ideateResult && ideateResult.candidates) || [];
    // A partial pool after an abandoned batch is not a measurement -- see the
    // matching branch (and its full rationale) on the Anthropic path above.
    if (candidates.length > 0 && classification.abandoned.length > 0) {
      return {
        terminalState: "failed",
        failureKind: "timeout",
        detail: truncateDetail(
          abandonPrefix(classification, "OpenAIBatchProvider") +
            `discarding a PARTIAL pool of ${candidates.length} candidate(s) assembled from the rounds that did finish -- ` +
            "storing it would silently under-report this cell's pool size",
        ),
        tokens: { tokens_by_model: tokensByModel },
        diagnostics,
      };
    }
    if (candidates.length === 0) {
      const allRefused = !!(ideateResult && ideateResult.meta && ideateResult.meta.agentsFailed === ideateResult.meta.agentsAttempted);
      const pool = classifyPoolFailure(diagnostics, { providerName: "OpenAIBatchProvider", allRefused });
      return { terminalState: "failed", failureKind: pickFailureKind(classification, pool.kind), detail: truncateDetail(abandonPrefix(classification, "OpenAIBatchProvider") + pool.detail), tokens: { tokens_by_model: tokensByModel }, diagnostics };
    }
    // An UNDERSIZED pool is not a measurement (issue #102) -- see the matching
    // branch (and its full rationale, plus the guard-ordering reasoning) on the
    // Anthropic path above. Arm H and arm G's OpenAI slots have exactly the same
    // shape, so they get exactly the same rule rather than waiting to reproduce
    // the bug on a second provider.
    const undersized = classifyUndersizedPool(ideateResult, diagnostics, {
      providerName: "OpenAIBatchProvider",
      candidateCount: candidates.length,
    });
    if (undersized) {
      return {
        terminalState: "failed",
        failureKind: pickFailureKind(classification, undersized.kind),
        detail: truncateDetail(abandonPrefix(classification, "OpenAIBatchProvider") + undersized.detail),
        tokens: { tokens_by_model: tokensByModel },
        diagnostics,
        meta: ideateResult.meta,
      };
    }

    return { terminalState: "completed", result: { candidates, agents: ideateResult.agents, meta: ideateResult.meta }, tokens: { tokens_by_model: tokensByModel }, diagnostics };
  }

  // ── single mode: POST /v1/chat/completions directly ──────────────────────
  async #completeSingle(req, { addUsage, classification, diagnostics, cellMaxTokens }) {
    const params = buildOpenAIChatParams(withCellMaxTokens(req, cellMaxTokens));
    const { ok, status, json, error, errorBody } = await openaiFetchWithRetry(
      this.fetchImpl,
      "https://api.openai.com/v1/chat/completions",
      openaiHeaders(this.apiKey),
      params,
      { maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!ok) {
      classifyTransportOutcome(status, error, classification, errorBody);
      return { ok: false };
    }
    addUsage(req.model, json.usage);
    return handleReplyText({
      model: req.model,
      stopReason: normalizeOpenAIFinishReason(json),
      usage: json && json.usage,
      text: extractOpenAIText(json),
      diagnostics,
    });
  }

  /** Surrender an in-flight OpenAI batch at the poll ceiling (issue #92).
   *  Mirrors AnthropicBatchProvider#abandon exactly; only the cancel endpoint
   *  differs (`POST /v1/batches/{id}/cancel`). */
  async #abandon(batch, batchId, startedAt, lastStatus, submittedAt) {
    const elapsedMs = Date.now() - startedAt;
    const cancelled = this.cancelOnAbandon
      ? await cancelBatchQuietly(this.fetchImpl, `https://api.openai.com/v1/batches/${batchId}/cancel`, openaiHeaders(this.apiKey), { sleep: this.sleep, logger: this.logger })
      : null;
    this.logger(
      `OpenAIBatchProvider: poll ceiling reached after ${elapsedMs}ms (maxPollMs=${this.maxPollMs}) -- abandoning batch ${batchId}. ` +
        (cancelled === null
          ? "cancelOnAbandon is off, so it was left running."
          : cancelled === true
            ? "It was cancelled so it will not bill unattended."
            : `The cancel call did not succeed (${cancelled}) -- it may still bill; cancel by hand: POST /v1/batches/${batchId}/cancel.`) +
        ` The handle is durable: GET /v1/batches/${batchId} still reports it.`,
    );
    const record = { batchId, elapsedMs, maxPollMs: this.maxPollMs, lastStatus: lastStatus || null, cancelled };
    for (const ctx of new Set(batch.map((entry) => entry.ctx))) {
      ctx.classification.timedOut = true;
      if (!Array.isArray(ctx.classification.abandoned)) ctx.classification.abandoned = [];
      ctx.classification.abandoned.push(record);
      if (!ctx.resumeEnabled) continue;
      const submitToCustom = {};
      for (const entry of batch) {
        if (entry.ctx !== ctx || !entry.customId) continue;
        // Model recorded at submit time -- see the Anthropic path for why the
        // recovered reply's own `model` field is not trusted as the sole source.
        submitToCustom[entry.submitId] = { customId: entry.customId, model: entry.req && entry.req.model };
      }
      // `outputFileId` is unknown at abandonment (OpenAI only populates it
      // once the batch reaches a terminal state), so recovery re-reads the
      // batch object to find it -- see #recoverOneOpenAIBatch.
      ctx.outstanding.push({
        provider: "openai",
        batchId,
        submittedAt: submittedAt || new Date().toISOString(),
        cancelled,
        submitToCustom,
      });
    }
    for (const entry of batch) entry.resolve({ ok: false, __failureKind: "timeout" });
  }

  // ── batch mode: buffer this call; flush the round as one OpenAI Batch ─────
  #completeBatched(req, ctx) {
    const params = buildOpenAIChatParams(withCellMaxTokens(req, ctx.cellMaxTokens));
    const customId = ctx.resumeEnabled ? contentCustomId(params, ctx.customIdCounts) : null;

    // Replay hit -- see AnthropicBatchProvider#completeBatched for why this is
    // checked before the abandonment short-circuit and why it never meters.
    if (customId && Object.prototype.hasOwnProperty.call(ctx.replay, customId)) {
      const cached = ctx.replay[customId] || {};
      ctx.replayHits += 1;
      return Promise.resolve(
        handleReplyText({
          model: cached.model || req.model,
          stopReason: cached.stopReason,
          usage: cached.usage,
          text: cached.text,
          diagnostics: ctx.diagnostics,
        }),
      );
    }

    // Same post-abandonment short-circuit as the Anthropic path -- see there
    // for why a later round must not submit a second batch for a cell that has
    // already been given up on.
    if (ctx && ctx.classification && (ctx.classification.abandoned || []).length > 0) {
      return Promise.resolve({ ok: false, __failureKind: "timeout" });
    }
    return new Promise((resolve, reject) => {
      this.#pending.push({ req, params, customId, resolve, reject, ctx });
      if (!this.#flushScheduled) {
        this.#flushScheduled = true;
        setTimeout(() => this.#flush(), 0);
      }
    });
  }

  /** Re-poll every durable OpenAI handle (#103). Mirrors the Anthropic path;
   *  the differences are OpenAI's own, not stylistic -- a separate output-file
   *  fetch, a different terminal-status vocabulary, and a cancellation whose
   *  partial-output behaviour OpenAI does not document (see below). */
  async #recoverOutstanding(ctx) {
    const kept = [];
    for (const handle of ctx.outstanding) {
      if (!handle || handle.provider !== "openai" || !handle.batchId) continue;
      if (batchResultsExpired(handle.submittedAt, OPENAI_RESULTS_RETENTION_MS)) {
        this.logger(
          `OpenAIBatchProvider: batch ${handle.batchId} is past the documented ${OPENAI_RESULTS_RETENTION_DAYS}-day output-file retention ` +
            `(submitted ${handle.submittedAt}) -- dropping the handle and re-submitting these requests fresh.`,
        );
        continue;
      }
      if (await this.#recoverOneOpenAIBatch(ctx, handle)) kept.push(handle);
    }
    ctx.outstanding.length = 0;
    ctx.outstanding.push(...kept);
  }

  /** @returns {Promise<boolean>} true to KEEP the handle for a later attempt. */
  async #recoverOneOpenAIBatch(ctx, handle) {
    const url = `https://api.openai.com/v1/batches/${handle.batchId}`;
    const headers = openaiHeaders(this.apiKey);
    const startedAt = Date.now();
    const deadline = startedAt + this.maxPollMs;
    const terminal = new Set(["completed", "failed", "expired", "cancelled"]);

    let poll = await openaiFetchWithRetry(this.fetchImpl, url, headers, undefined, {
      method: "GET",
      maxRetries: this.maxRetries,
      sleep: this.sleep,
      logger: this.logger,
    });
    if (!poll.ok) {
      const gone = poll.status === 404 || poll.status === 410;
      this.logger(
        `OpenAIBatchProvider: could not re-poll batch ${handle.batchId} (status ${poll.status}) -- ` +
          (gone ? "the handle is gone; re-submitting these requests fresh." : "keeping the handle for a later attempt."),
      );
      return !gone;
    }

    while (!terminal.has(poll.json.status)) {
      if (Date.now() > deadline) {
        this.logger(
          `OpenAIBatchProvider: resumed batch ${handle.batchId} is still ${poll.json.status} after ${Date.now() - startedAt}ms ` +
            `(maxPollMs=${this.maxPollMs}) -- surrendering again without submitting anything new. The handle is retained.`,
        );
        ctx.classification.timedOut = true;
        if (!Array.isArray(ctx.classification.abandoned)) ctx.classification.abandoned = [];
        ctx.classification.abandoned.push({
          batchId: handle.batchId,
          elapsedMs: Date.now() - startedAt,
          maxPollMs: this.maxPollMs,
          lastStatus: poll.json.status,
          cancelled: null,
          resumed: true,
        });
        return true;
      }
      await this.sleep(this.pollIntervalMs);
      poll = await openaiFetchWithRetry(this.fetchImpl, url, headers, undefined, {
        method: "GET",
        maxRetries: this.maxRetries,
        sleep: this.sleep,
        logger: this.logger,
      });
      if (!poll.ok) return poll.status !== 404 && poll.status !== 410;
    }

    // ── A NAMED RESIDUAL, not an assumption ───────────────────────────────
    // Anthropic documents explicitly that cancelling preserves already-
    // succeeded results. OpenAI documents that a cancelling batch lets
    // "in-flight requests complete (up to 10 minutes)" and then becomes
    // `cancelled`, but does NOT state whether an output file is produced for
    // the requests that did complete. So this path does not assume one: a
    // terminal batch with no `output_file_id` recovers nothing and degrades to
    // a fresh submit, which is correct whichever way OpenAI actually behaves.
    // Verified against developers.openai.com/api/docs/guides/batch 2026-09-02.
    const outputFileId = poll.json.output_file_id;
    if (!outputFileId) {
      this.logger(
        `OpenAIBatchProvider: batch ${handle.batchId} reached '${poll.json.status}' with no output_file_id -- nothing to recover; re-submitting fresh.`,
      );
      return false;
    }
    const results = await openaiFetchWithRetry(
      this.fetchImpl,
      `https://api.openai.com/v1/files/${outputFileId}/content`,
      headers,
      undefined,
      { method: "GET", raw: true, maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!results.ok) {
      this.logger(`OpenAIBatchProvider: batch ${handle.batchId} output file download failed (status ${results.status}) -- keeping the handle.`);
      return true;
    }

    let recovered = 0;
    for (const line of results.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const mapped = (handle.submitToCustom || {})[row.custom_id];
      const customId = mapped && mapped.customId;
      if (!customId) continue;
      const resp = row.response;
      // Only a 2xx row carries a reply. Everything else is re-issued.
      if (row.error || !resp || !(resp.status_code >= 200 && resp.status_code < 300) || !resp.body) continue;
      const model = mapped.model || resp.body.model || null;
      ctx.addUsage(model, resp.body.usage); // metered at RECOVERY -- see the Anthropic path
      ctx.replay[customId] = {
        model,
        text: extractOpenAIText(resp.body),
        stopReason: normalizeOpenAIFinishReason(resp.body),
        usage: resp.body.usage || null,
      };
      recovered += 1;
    }
    this.logger(
      `OpenAIBatchProvider: recovered ${recovered} already-paid-for repl${recovered === 1 ? "y" : "ies"} from batch ${handle.batchId} ` +
        "-- these will be replayed instead of re-submitted.",
    );
    return false;
  }

  async #flush() {
    const batch = this.#pending;
    this.#pending = [];
    this.#flushScheduled = false;
    if (!batch.length) return;

    // Content-derived ids with the same submitId/customId split the Anthropic
    // path uses -- see there.
    const seenSubmitIds = new Set();
    const lines = batch.map((entry, i) => {
      const body = entry.params || buildOpenAIChatParams(withCellMaxTokens(entry.req, entry.ctx.cellMaxTokens));
      let submitId = entry.customId || `req-${i}-${Math.random().toString(36).slice(2, 8)}`;
      for (let n = 1; seenSubmitIds.has(submitId); n += 1) submitId = `${entry.customId}_${n}`;
      seenSubmitIds.add(submitId);
      entry.submitId = submitId;
      return { custom_id: submitId, method: "POST", url: "/v1/chat/completions", body };
    });
    const byCustomId = new Map(lines.map((l, i) => [l.custom_id, batch[i]]));
    const jsonl = lines.map((l) => JSON.stringify(l)).join("\n");

    // 1. Upload the JSONL as a batch input file (multipart/form-data).
    const form = new FormData();
    form.append("purpose", "batch");
    form.append("file", new Blob([jsonl], { type: "application/jsonl" }), "batch-input.jsonl");
    const upload = await openaiFetchWithRetry(
      this.fetchImpl,
      "https://api.openai.com/v1/files",
      openaiAuthOnlyHeaders(this.apiKey),
      form,
      { formData: true, maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!upload.ok) {
      const kind = classifyTransportKind(upload.status, upload.errorBody);
      for (const entry of batch) {
        classifyTransportOutcome(upload.status, upload.error, entry.ctx.classification, upload.errorBody);
        entry.resolve({ ok: false, __failureKind: kind });
      }
      return;
    }

    // 2. Create the batch job over that file.
    const create = await openaiFetchWithRetry(
      this.fetchImpl,
      "https://api.openai.com/v1/batches",
      openaiHeaders(this.apiKey),
      { input_file_id: upload.json.id, endpoint: "/v1/chat/completions", completion_window: "24h" },
      { maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!create.ok) {
      for (const entry of batch) {
        classifyTransportOutcome(create.status, create.error, entry.ctx.classification, create.errorBody);
        entry.resolve({ ok: false, __failureKind: classifyTransportKind(create.status, create.errorBody) });
      }
      return;
    }

    const batchId = create.json.id;
    const startedAt = Date.now();
    // Wall-clock submission time for the 30-day output-file retention check a
    // LATER process performs. OpenAI's `created_at` is unix SECONDS.
    const submittedAt = Number.isFinite(create.json.created_at)
      ? new Date(create.json.created_at * 1000).toISOString()
      : new Date().toISOString();
    const deadline = startedAt + this.maxPollMs;
    let batchStatus = create.json;
    // Terminal OpenAI batch states: completed | failed | expired | cancelled.
    while (batchStatus.status !== "completed") {
      if (batchStatus.status === "failed" || batchStatus.status === "expired" || batchStatus.status === "cancelled") {
        for (const entry of batch) {
          entry.ctx.classification.transportError = true;
          entry.resolve({ ok: false, __failureKind: "transport_error" });
        }
        return;
      }
      if (Date.now() > deadline) {
        await this.#abandon(batch, batchId, startedAt, batchStatus.status, submittedAt);
        return;
      }
      await this.sleep(this.pollIntervalMs);
      const poll = await openaiFetchWithRetry(
        this.fetchImpl,
        `https://api.openai.com/v1/batches/${batchId}`,
        openaiHeaders(this.apiKey),
        undefined,
        { method: "GET", maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
      );
      if (!poll.ok) {
        for (const entry of batch) {
          classifyTransportOutcome(poll.status, poll.error, entry.ctx.classification, poll.errorBody);
          entry.resolve({ ok: false, __failureKind: classifyTransportKind(poll.status, poll.errorBody) });
        }
        return;
      }
      batchStatus = poll.json;
    }

    // 3. Download the output file (JSONL, keyed by custom_id).
    const results = await openaiFetchWithRetry(
      this.fetchImpl,
      `https://api.openai.com/v1/files/${batchStatus.output_file_id}/content`,
      openaiHeaders(this.apiKey),
      undefined,
      { method: "GET", raw: true, maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!results.ok) {
      for (const entry of batch) {
        classifyTransportOutcome(results.status, results.error, entry.ctx.classification, results.errorBody);
        entry.resolve({ ok: false, __failureKind: classifyTransportKind(results.status, results.errorBody) });
      }
      return;
    }

    const seen = new Set();
    for (const line of results.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const entry = byCustomId.get(row.custom_id);
      if (!entry) continue;
      seen.add(row.custom_id);
      const resp = row.response;
      if (!row.error && resp && resp.status_code >= 200 && resp.status_code < 300 && resp.body) {
        entry.ctx.addUsage(entry.req.model, resp.body.usage);
        const text = extractOpenAIText(resp.body);
        const stopReason = normalizeOpenAIFinishReason(resp.body);
        // Remember every reply, not just abandoned ones -- see the Anthropic
        // path for why a completed round-1 must be replayable to reach an
        // abandoned round-2 without paying for round 1 twice.
        if (entry.ctx.resumeEnabled && entry.customId) {
          entry.ctx.replay[entry.customId] = { model: entry.req.model, text, stopReason, usage: resp.body.usage || null };
        }
        entry.resolve(
          handleReplyText({
            model: entry.req.model,
            stopReason,
            usage: resp.body.usage,
            text,
            diagnostics: entry.ctx.diagnostics,
          }),
        );
      } else if (isBillingRefusal(resp && resp.status_code, (resp && resp.body) || row.error)) {
        // issue #88 -- a per-row quota refusal. On the OpenAI side this is
        // the SAME status (429) as an ordinary rate limit, so the body's
        // signature is the only thing that tells them apart; see
        // isBillingRefusal's own note that this signature is
        // documentation-derived rather than capture-verified.
        entry.ctx.classification.paymentRequired = true;
        entry.resolve({ ok: false, __failureKind: "payment_required" });
      } else if (resp && resp.status_code === 429) {
        entry.ctx.classification.rateLimited = true;
        entry.resolve({ ok: false, __failureKind: "rate_limited" });
      } else {
        entry.ctx.classification.transportError = true;
        entry.resolve({ ok: false, __failureKind: "transport_error" });
      }
    }
    for (const [customId, entry] of byCustomId) {
      if (!seen.has(customId)) {
        entry.ctx.classification.transportError = true;
        entry.resolve({ ok: false, __failureKind: "transport_error" });
      }
    }
  }
}

// ── OpenAI transport (mirrors the Anthropic helpers; force-strip by construction) ──

/**
 * Build the OpenAI chat-completions request body BY CONSTRUCTION from an
 * explicit allowlist — model, messages, max_completion_tokens — and never a
 * sampling param, for ANY model (§3.3 force-strip; see the class header and the
 * matching buildAnthropicMessageParams rationale). A future edit cannot leak a
 * temperature through because there is no field-copy path that would carry one.
 */
export function buildOpenAIChatParams(req) {
  return {
    model: req.model,
    messages: [{ role: "user", content: req.prompt }],
    max_completion_tokens: req.maxTokens ?? 2048,
    // Deliberately no temperature / top_p / top_k, for any model. See above.
  };
}

// Exported (issue #77): OpenAIJudgeProvider (evals/judge/score.mjs) drives the
// SAME OpenAI transport as OpenAIBatchProvider above — these two header
// builders are the shared seam, imported rather than re-implemented, so the
// judge path can never drift from the generation path's auth/content-type
// handling.
export function openaiHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

/** Auth-only headers for a multipart upload — fetch sets the multipart
 *  Content-Type (with boundary) itself when the body is a FormData, so we must
 *  NOT set content-type here or the boundary is lost. */
export function openaiAuthOnlyHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}` };
}

/**
 * Normalize OpenAI's `finish_reason` to the Anthropic `stop_reason` vocabulary
 * (issue #93). Without this the truncation check -- `stopReason ===
 * "max_tokens"` -- would silently never fire on the OpenAI path, because
 * OpenAI signals truncation as `choices[0].finish_reason === "length"`, on the
 * response body rather than anywhere `extractOpenAIText` looks. The mirrored
 * fix would have LOOKED complete while detecting nothing.
 *
 *   length         -> max_tokens   (truncated: the exact arm-A failure shape)
 *   content_filter -> refusal      (nearest FAILURE_KINDS-aligned meaning)
 *   stop           -> end_turn     (the model finished on its own)
 *
 * Anything else (e.g. tool_calls, or a value OpenAI adds later) is passed
 * through verbatim so it shows up in the ledger's stop_reasons histogram
 * rather than being flattened into "unknown".
 */
export function normalizeOpenAIFinishReason(body) {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : undefined;
  const finishReason = choice && choice.finish_reason;
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "content_filter") return "refusal";
  if (finishReason === "stop") return "end_turn";
  return finishReason || null;
}

/** choices[0].message.content of an OpenAI chat completion, or "". */
export function extractOpenAIText(body) {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : undefined;
  const content = choice && choice.message ? choice.message.content : undefined;
  return typeof content === "string" ? content : "";
}

/**
 * OpenAI fetch wrapper with retry/backoff on 429/5xx, using the injected
 * `sleep`. Never throws — resolves to { ok, json|text } or { ok:false, status,
 * error }. `formData:true` sends the body as-is (a FormData) with no JSON
 * serialization and no content-type override (the multipart boundary must come
 * from fetch); otherwise the body is JSON-serialized.
 */
export async function openaiFetchWithRetry(fetchImpl, url, headers, body, { method = "POST", raw = false, formData = false, maxRetries = 3, sleep, logger } = {}) {
  let lastStatus;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : formData ? body : JSON.stringify(body),
      });
    } catch (err) {
      lastError = err;
      lastStatus = undefined;
      if (attempt < maxRetries) {
        if (logger) logger(`openaiFetchWithRetry: fetch rejected (attempt ${attempt + 1}/${maxRetries + 1}): ${err && err.message}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      return { ok: false, status: undefined, error: err };
    }
    if (res.ok) {
      return raw ? { ok: true, text: await res.text() } : { ok: true, json: await res.json() };
    }
    lastStatus = res.status;
    // issue #88 -- same body-before-retry order as anthropicFetchWithRetry,
    // and it matters MORE here: OpenAI delivers quota exhaustion as a 429,
    // which without this check retries the full ladder and then classifies
    // `rate_limited` (transient), so every remaining cell marches into it.
    const errorBody = await readErrorBody(res);
    const billing = isBillingRefusal(res.status, errorBody);
    const retryable = !billing && (res.status === 429 || res.status >= 500);
    if (retryable && attempt < maxRetries) {
      if (logger) logger(`openaiFetchWithRetry: HTTP ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying`);
      await sleep(backoffMs(attempt));
      continue;
    }
    if (billing && logger) logger(`openaiFetchWithRetry: HTTP ${res.status} is a billing/quota refusal -- not retrying`);
    return { ok: false, status: res.status, error: undefined, errorBody };
  }
  return { ok: false, status: lastStatus, error: lastError };
}
