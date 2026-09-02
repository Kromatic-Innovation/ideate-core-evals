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
import { buildRound1Prompt, buildRound2Prompt } from "./prompts.mjs";

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
   *   @param {number} [opts.maxPollMs]        poll ceiling before classifying `timeout` (live default 15 min).
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
    maxPollMs = 15 * 60 * 1000,
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
    this.maxPollMs = maxPollMs;
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
    const classification = { transportError: false, rateLimited: false, timedOut: false };

    const complete =
      mode === "single"
        ? (req) => this.#completeSingle(req, { addUsage, classification })
        : (req) => this.#completeBatched(req, { addUsage, classification });

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
        detail: `AnthropicBatchProvider: ideateImpl threw: ${err && err.message}`,
        tokens: { tokens_by_model: tokensByModel },
      };
    }

    const candidates = (ideateResult && ideateResult.candidates) || [];
    if (candidates.length === 0) {
      // IC-08 silent mode: ideateCore resolved cleanly (no throw) but the
      // pool is empty. Distinguish "everyone refused" from "everyone
      // errored/timed out/rate-limited" using whatever the complete() calls
      // observed; empty_pool is the correct default per spec when nothing
      // more specific was detected.
      const allRefused =
        ideateResult && ideateResult.meta && ideateResult.meta.agentsFailed === ideateResult.meta.agentsAttempted;
      return {
        terminalState: "failed",
        failureKind: pickFailureKind(classification, allRefused ? "refusal" : "empty_pool"),
        detail: "AnthropicBatchProvider: ideateCore returned an empty candidate pool",
        tokens: { tokens_by_model: tokensByModel },
      };
    }

    return {
      terminalState: "completed",
      result: { candidates, agents: ideateResult.agents, meta: ideateResult.meta },
      tokens: { tokens_by_model: tokensByModel },
    };
  }

  // ── single mode: POST /v1/messages directly, resolve immediately ─────────
  async #completeSingle(req, { addUsage, classification }) {
    const params = buildAnthropicMessageParams(req);
    const { ok, status, json, error } = await anthropicFetchWithRetry(
      this.fetchImpl,
      "https://api.anthropic.com/v1/messages",
      anthropicHeaders(this.apiKey),
      params,
      { maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!ok) {
      classifyTransportOutcome(status, error, classification);
      return { ok: false };
    }
    addUsage(req.model, json.usage);
    return { ok: true, text: extractAnthropicText(json) };
  }

  // ── batch mode: buffer this call; flush the whole round as one batch ─────
  #completeBatched(req, ctx) {
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

  async #flush() {
    const batch = this.#pending;
    this.#pending = [];
    this.#flushScheduled = false;
    if (!batch.length) return;

    const requests = batch.map((entry, i) => ({
      custom_id: `req-${i}-${Math.random().toString(36).slice(2, 8)}`,
      params: buildAnthropicMessageParams(entry.req),
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
      const kind = classifyTransportKind(submit.status, submit.error);
      for (const entry of batch) {
        classifyTransportOutcome(submit.status, submit.error, entry.ctx.classification);
        entry.resolve({ ok: false, __failureKind: kind });
      }
      return;
    }

    const batchId = submit.json.id;
    const deadline = Date.now() + this.maxPollMs;
    // `batchStatus` tracks the most recently observed batch object (submit's
    // response initially, then each poll's) so "ended" can be detected
    // whether it happens on the submit response itself (a trivially fast
    // batch, e.g. in a test) or only after one or more polls.
    let batchStatus = submit.json;

    while (batchStatus.processing_status !== "ended") {
      if (Date.now() > deadline) {
        for (const entry of batch) {
          entry.ctx.classification.timedOut = true;
          entry.resolve({ ok: false, __failureKind: "timeout" });
        }
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
          classifyTransportOutcome(poll.status, poll.error, entry.ctx.classification);
          entry.resolve({ ok: false, __failureKind: classifyTransportKind(poll.status, poll.error) });
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
        classifyTransportOutcome(results.status, results.error, entry.ctx.classification);
        entry.resolve({ ok: false, __failureKind: classifyTransportKind(results.status, results.error) });
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
        entry.resolve({ ok: true, text: extractAnthropicText(message) });
      } else if (row.result && row.result.type === "errored") {
        const err = row.result.error || {};
        if (err.type === "rate_limit_error") entry.ctx.classification.rateLimited = true;
        else entry.ctx.classification.transportError = true;
        entry.resolve({ ok: false, __failureKind: err.type === "rate_limit_error" ? "rate_limited" : "transport_error" });
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
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      if (logger) logger(`anthropicFetchWithRetry: HTTP ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying`);
      await sleep(backoffMs(attempt));
      continue;
    }
    return { ok: false, status: res.status, error: undefined };
  }
  return { ok: false, status: lastStatus, error: lastError };
}

function backoffMs(attempt) {
  return 2 ** attempt * 100; // 100ms, 200ms, 400ms, ... -- tests inject a no-op sleep so this never actually delays a test
}

/** Mutate `classification` in place based on a failed fetch's status/error. */
export function classifyTransportOutcome(status, error, classification) {
  if (status === 429) classification.rateLimited = true;
  else classification.transportError = true;
}

/** Same signal as classifyTransportOutcome, but returned as a FAILURE_KINDS value. */
export function classifyTransportKind(status) {
  return status === 429 ? "rate_limited" : "transport_error";
}

/**
 * Pick the most specific failure kind observed during this cell's calls,
 * falling back to `fallback` when nothing more specific was recorded.
 * Precedence: timeout > rate_limited > transport_error > fallback -- a
 * timeout is the most actionable/specific signal when multiple flags got
 * set (e.g. a batch that both saw a transient 429 AND then blew the poll
 * ceiling should report timeout, not rate_limited).
 */
export function pickFailureKind(classification, fallback) {
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
   *   @param {number}   [opts.maxPollMs]       (live default 15 min)
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
    maxPollMs = 15 * 60 * 1000,
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
    this.maxPollMs = maxPollMs;
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
    const classification = { transportError: false, rateLimited: false, timedOut: false };

    const complete =
      mode === "single"
        ? (req) => this.#completeSingle(req, { addUsage, classification })
        : (req) => this.#completeBatched(req, { addUsage, classification });

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
      return { terminalState: "failed", failureKind: pickFailureKind(classification, "transport_error"), detail: `OpenAIBatchProvider: ideateImpl threw: ${err && err.message}`, tokens: { tokens_by_model: tokensByModel } };
    }

    const candidates = (ideateResult && ideateResult.candidates) || [];
    if (candidates.length === 0) {
      const allRefused = ideateResult && ideateResult.meta && ideateResult.meta.agentsFailed === ideateResult.meta.agentsAttempted;
      return { terminalState: "failed", failureKind: pickFailureKind(classification, allRefused ? "refusal" : "empty_pool"), detail: "OpenAIBatchProvider: ideateCore returned an empty candidate pool", tokens: { tokens_by_model: tokensByModel } };
    }

    return { terminalState: "completed", result: { candidates, agents: ideateResult.agents, meta: ideateResult.meta }, tokens: { tokens_by_model: tokensByModel } };
  }

  // ── single mode: POST /v1/chat/completions directly ──────────────────────
  async #completeSingle(req, { addUsage, classification }) {
    const params = buildOpenAIChatParams(req);
    const { ok, status, json, error } = await openaiFetchWithRetry(
      this.fetchImpl,
      "https://api.openai.com/v1/chat/completions",
      openaiHeaders(this.apiKey),
      params,
      { maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!ok) {
      classifyTransportOutcome(status, error, classification);
      return { ok: false };
    }
    addUsage(req.model, json.usage);
    return { ok: true, text: extractOpenAIText(json) };
  }

  // ── batch mode: buffer this call; flush the round as one OpenAI Batch ─────
  #completeBatched(req, ctx) {
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
      body: buildOpenAIChatParams(entry.req),
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
      const kind = classifyTransportKind(upload.status);
      for (const entry of batch) {
        classifyTransportOutcome(upload.status, upload.error, entry.ctx.classification);
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
        classifyTransportOutcome(create.status, create.error, entry.ctx.classification);
        entry.resolve({ ok: false, __failureKind: classifyTransportKind(create.status) });
      }
      return;
    }

    const batchId = create.json.id;
    const deadline = Date.now() + this.maxPollMs;
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
        for (const entry of batch) {
          entry.ctx.classification.timedOut = true;
          entry.resolve({ ok: false, __failureKind: "timeout" });
        }
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
          classifyTransportOutcome(poll.status, poll.error, entry.ctx.classification);
          entry.resolve({ ok: false, __failureKind: classifyTransportKind(poll.status) });
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
        classifyTransportOutcome(results.status, results.error, entry.ctx.classification);
        entry.resolve({ ok: false, __failureKind: classifyTransportKind(results.status) });
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
        entry.resolve({ ok: true, text: extractOpenAIText(resp.body) });
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
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      if (logger) logger(`openaiFetchWithRetry: HTTP ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying`);
      await sleep(backoffMs(attempt));
      continue;
    }
    return { ok: false, status: res.status, error: undefined };
  }
  return { ok: false, status: lastStatus, error: lastError };
}
