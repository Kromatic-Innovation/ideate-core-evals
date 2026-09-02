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
   */
  async generate(cell, arm, { mode = "batch", timestamp } = {}) {
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

    const ctx = { addUsage, classification, diagnostics, cellMaxTokens };
    const complete = mode === "single" ? (req) => this.#completeSingle(req, ctx) : (req) => this.#completeBatched(req, ctx);

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
      this.#pending.push({ req, resolve, reject, ctx });
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
  async #abandon(batch, batchId, startedAt, lastStatus) {
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
    }
    for (const entry of batch) entry.resolve({ ok: false, __failureKind: "timeout" });
  }

  async #flush() {
    const batch = this.#pending;
    this.#pending = [];
    this.#flushScheduled = false;
    if (!batch.length) return;

    const requests = batch.map((entry, i) => ({
      custom_id: `req-${i}-${Math.random().toString(36).slice(2, 8)}`,
      params: buildAnthropicMessageParams(withCellMaxTokens(entry.req, entry.ctx.cellMaxTokens)),
    }));
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
    const deadline = startedAt + this.maxPollMs;
    // `batchStatus` tracks the most recently observed batch object (submit's
    // response initially, then each poll's) so "ended" can be detected
    // whether it happens on the submit response itself (a trivially fast
    // batch, e.g. in a test) or only after one or more polls.
    let batchStatus = submit.json;

    while (batchStatus.processing_status !== "ended") {
      if (Date.now() > deadline) {
        await this.#abandon(batch, batchId, startedAt, batchStatus.processing_status);
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
        entry.resolve(
          handleReplyText({
            model: entry.req.model,
            stopReason: message && message.stop_reason,
            usage: message && message.usage,
            text: extractAnthropicText(message),
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
    this.maxRetries = maxRetries;
    this.logger = logger;
    this.#pending = [];
    this.#flushScheduled = false;
  }

  #pending;
  #flushScheduled;

  async generate(cell, arm, { mode = "batch" } = {}) {
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
    const ctx = { addUsage, classification, diagnostics, cellMaxTokens };

    const complete = mode === "single" ? (req) => this.#completeSingle(req, ctx) : (req) => this.#completeBatched(req, ctx);

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
  async #abandon(batch, batchId, startedAt, lastStatus) {
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
    }
    for (const entry of batch) entry.resolve({ ok: false, __failureKind: "timeout" });
  }

  // ── batch mode: buffer this call; flush the round as one OpenAI Batch ─────
  #completeBatched(req, ctx) {
    // Same post-abandonment short-circuit as the Anthropic path -- see there
    // for why a later round must not submit a second batch for a cell that has
    // already been given up on.
    if (ctx && ctx.classification && (ctx.classification.abandoned || []).length > 0) {
      return Promise.resolve({ ok: false, __failureKind: "timeout" });
    }
    return new Promise((resolve, reject) => {
      this.#pending.push({ req, resolve, reject, ctx });
      if (!this.#flushScheduled) {
        this.#flushScheduled = true;
        setTimeout(() => this.#flush(), 0);
      }
    });
  }

  async #flush() {
    const batch = this.#pending;
    this.#pending = [];
    this.#flushScheduled = false;
    if (!batch.length) return;

    const lines = batch.map((entry, i) => ({
      custom_id: `req-${i}-${Math.random().toString(36).slice(2, 8)}`,
      method: "POST",
      url: "/v1/chat/completions",
      body: buildOpenAIChatParams(withCellMaxTokens(entry.req, entry.ctx.cellMaxTokens)),
    }));
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
        await this.#abandon(batch, batchId, startedAt, batchStatus.status);
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
        entry.resolve(
          handleReplyText({
            model: entry.req.model,
            stopReason: normalizeOpenAIFinishReason(resp.body),
            usage: resp.body.usage,
            text: extractOpenAIText(resp.body),
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
