// ocsai.mjs — OCSAI (Open Creativity Scoring with AI) adapter: a second,
// pre-calibrated judge on the AUT / classic-divergent-thinking stratum only.
// See issue #17 (2026-09-01 unblock comment) and docs/PREREGISTRATION.md
// §2 / §4.2 / Appendix B8.
//
// ── Registered position -- do not re-litigate ────────────────────────────────
// OCSAI is exploratory, relative-ordering only. §2 already warns its absolute
// scores are suspect for our longer candidates -- it is trained on Alternate-
// Uses responses of a few words. The only defensible statistic is a
// within-brief rank correlation against the LLM judge, which is a
// judge-agreement measure, not an outcome measure. Nothing in this module
// computes or asserts that statistic -- it stores raw OCSAI output; any
// consumer that treats it as an outcome is misusing it.
//
// ── Endpoint (2026-08-02 investigation, issue #17) ───────────────────────────
// POST https://openscoring.du.edu/llm, application/x-www-form-urlencoded,
// JSON response. Required params: model, input (CSV-encoded responses).
// Optional: task, language, prompt, question, elab_method, logprob_scoring.
// Metadata: GET https://openscoring.du.edu/about. The response carries a
// `cite` field so REPORT.md can cite the instrument.
//
// ── Interface: mirrors evals/harness/provider.mjs's contract ────────────────
// generate(cell, arm, opts) -> { terminalState, result, tokens, failureKind? }
// terminalState is "completed" | "failed"; a failed response carries a
// lib/accounting.mjs FAILURE_KINDS value. NEVER throws for a transport error
// -- every catchable failure (network rejection, non-2xx after retries) is
// classified and returned, same discipline as AnthropicBatchProvider /
// OpenAIBatchProvider in provider.mjs.
//
// ── AUT-stratum gate, defense in depth ───────────────────────────────────────
// generate() itself refuses (harness_error, no network call) for any cell
// whose stratum isn't "aut". The PRIMARY guarantee the acceptance criterion
// ("never invoked on the business, product or scientific strata") asks for is
// structural, not a runtime check: runOcsaiForAutStratum() below filters
// cells to stratum === "aut" BEFORE calling generate() at all, so the
// adapter's `.calls` spy never even records a call for another stratum in the
// intended call path. The in-generate() guard is a second line of defense for
// a caller that bypasses the filter helper.
//
// ── Throttle -- conservative, self-imposed, reportable ───────────────────────
// The service publishes no numeric rate limit ("No authentication is required
// for moderate use"). Default: serial, >= throttleMs between requests
// (2000ms -- 1 request / 2s), exponential backoff on 429/5xx (capped), and a
// hard per-instance request cap (maxRequests) after which further calls fail
// closed with budget_exceeded rather than touch the network. throttleConfig()
// exposes the live values so REPORT.md / a manifest can report what ran.

// This module returns failureKind values drawn from lib/accounting.mjs's
// FAILURE_KINDS taxonomy ("harness_error", "empty_pool", "rate_limited",
// "transport_error", "budget_exceeded") — see generate() below.

const DEFAULT_ENDPOINT = "https://openscoring.du.edu/llm";

export class OcsaiProvider {
  /**
   * @param {object} [opts]
   *   @param {string} [opts.apiKey]        optional X-API-KEY (lifts rate limits); never required.
   *   @param {typeof fetch} [opts.fetchImpl]  injected fetch; defaults to globalThis.fetch.
   *   @param {string} [opts.endpoint]      override for tests; defaults to the real OCSAI endpoint.
   *   @param {string} [opts.model]         OCSAI scoring model id, e.g. "gpt-4o".
   *   @param {string} [opts.task]          OCSAI `task` param, default "uses" (Alternate Uses Task).
   *   @param {number} [opts.throttleMs]    minimum ms between requests, default 2000 (1 req / 2s).
   *   @param {number} [opts.maxRequests]   hard cap on requests this instance will ever make, default 500.
   *   @param {number} [opts.maxRetries]    429/5xx retry budget, default 5.
   *   @param {number} [opts.baseDelayMs]   backoff base, default 1000ms.
   *   @param {number} [opts.maxDelayMs]    backoff cap, default 30000ms.
   *   @param {(ms:number)=>Promise<void>} [opts.sleepImpl]  injectable sleep; tests use a no-op.
   *   @param {(msg:string)=>void} [opts.logger]  defaults to console.error; tests inject a silent logger.
   *   @param {()=>number} [opts.now]       injectable clock for throttle tests.
   */
  constructor({
    apiKey,
    fetchImpl = globalThis.fetch,
    endpoint = DEFAULT_ENDPOINT,
    model = "gpt-4o",
    task = "uses",
    throttleMs = 2000,
    maxRequests = 500,
    maxRetries = 5,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    logger = (msg) => console.error(msg),
    now = () => Date.now(),
  } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
    this.model = model;
    this.task = task;
    this.throttleMs = throttleMs;
    this.maxRequests = maxRequests;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.sleepImpl = sleepImpl;
    this.logger = logger;
    this.now = now;

    this.requestCount = 0;
    this.lastRequestAt = null;
    /** Every call this provider received, in order — the spy the stratum-
     *  gating tests assert against (mirrors MockProvider.calls in
     *  provider.mjs). */
    this.calls = [];
  }

  /** The reportable throttle config — REPORT.md cites this alongside the
   *  request count and date (issue #17 acceptance criterion). */
  throttleConfig() {
    return {
      throttleMs: this.throttleMs,
      maxRequests: this.maxRequests,
      maxRetries: this.maxRetries,
      requestCount: this.requestCount,
    };
  }

  /**
   * @param {object} cell  { key, stratum, briefId, briefText?, result: { candidates } }
   * @param {object} arm   unused by OCSAI itself; accepted to match provider.mjs's shape.
   * @param {object} [opts] { mode } — accepted for interface symmetry; OCSAI has no batch API, every call is one HTTP request.
   */
  async generate(cell, arm, opts = {}) {
    this.calls.push({ key: cell && cell.key, stratum: cell && cell.stratum, mode: opts.mode });

    if (!cell || cell.stratum !== "aut") {
      return {
        terminalState: "failed",
        failureKind: "harness_error",
        detail: `OcsaiProvider: refusing to score stratum '${cell && cell.stratum}' — OCSAI applies to the AUT/classic-divergent-thinking stratum only`,
        tokens: {},
      };
    }

    const candidates = (cell.result && cell.result.candidates) || cell.candidates || [];
    if (candidates.length === 0) {
      return {
        terminalState: "failed",
        failureKind: "empty_pool",
        detail: "OcsaiProvider: no candidates to score",
        tokens: {},
      };
    }

    if (this.requestCount >= this.maxRequests) {
      return {
        terminalState: "failed",
        failureKind: "budget_exceeded",
        detail: `OcsaiProvider: hard request cap reached (${this.maxRequests}) — refusing to call the network`,
        tokens: {},
      };
    }

    await this.#throttle();

    const params = new URLSearchParams();
    params.set("model", this.model);
    params.set("input", candidates.map(csvEscape).join(","));
    params.set("task", this.task);
    if (cell.briefText) params.set("prompt", cell.briefText);

    const { ok, status, json, error } = await this.#fetchWithRetry(params);
    this.requestCount += 1;
    this.lastRequestAt = this.now();

    if (!ok) {
      const failureKind = status === 429 ? "rate_limited" : "transport_error";
      return {
        terminalState: "failed",
        failureKind,
        detail: `OcsaiProvider: request failed (status ${status ?? "n/a"}${error ? `, ${error.message}` : ""})`,
        tokens: {},
      };
    }

    return {
      terminalState: "completed",
      result: { scores: json, cite: json && json.cite },
      tokens: {},
    };
  }

  async #throttle() {
    if (this.lastRequestAt == null) return;
    const elapsed = this.now() - this.lastRequestAt;
    const wait = this.throttleMs - elapsed;
    if (wait > 0) await this.sleepImpl(wait);
  }

  async #fetchWithRetry(params) {
    let lastStatus;
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res;
      try {
        res = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(this.apiKey ? { "X-API-KEY": this.apiKey } : {}),
          },
          body: params.toString(),
        });
      } catch (err) {
        lastError = err;
        lastStatus = undefined;
        if (attempt < this.maxRetries) {
          this.logger(`OcsaiProvider: fetch rejected (attempt ${attempt + 1}/${this.maxRetries + 1}): ${err && err.message}`);
          await this.sleepImpl(this.#backoff(attempt));
          continue;
        }
        return { ok: false, status: undefined, error: err };
      }

      if (res.ok) {
        return { ok: true, json: await res.json() };
      }

      lastStatus = res.status;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        this.logger(`OcsaiProvider: HTTP ${res.status} (attempt ${attempt + 1}/${this.maxRetries + 1}), retrying`);
        await this.sleepImpl(this.#backoff(attempt));
        continue;
      }
      return { ok: false, status: res.status };
    }
    return { ok: false, status: lastStatus, error: lastError };
  }

  #backoff(attempt) {
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
  }
}

function csvEscape(text) {
  const s = String(text);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Run OCSAI over a set of cells, filtering to the AUT stratum BEFORE calling
 * the adapter at all — this is the structural guarantee behind "never
 * invoked on the business, product or scientific strata" (issue #17
 * acceptance criterion), not merely the in-generate() runtime guard above.
 * Non-AUT cells are skipped here silently (not failed) — OCSAI was never
 * meant to run on them; skipping isn't a modeled failure.
 *
 * @param {Array<object>} cells   planned/completed cells, each carrying `.stratum`.
 * @param {object} arm            passed through to generate() unchanged.
 * @param {OcsaiProvider} ocsaiProvider
 * @param {object} [opts]         passed through to generate() (e.g. { mode }).
 * @returns {Promise<Array<{cell:object, response:object}>>}
 */
export async function runOcsaiForAutStratum(cells, arm, ocsaiProvider, opts = {}) {
  const results = [];
  for (const cell of cells) {
    if (cell.stratum !== "aut") continue;
    // eslint-disable-next-line no-await-in-loop -- OCSAI has no batch API; the throttle requires serial calls anyway.
    results.push({ cell, response: await ocsaiProvider.generate(cell, arm, opts) });
  }
  return results;
}

/**
 * The store key an OCSAI score is written under — always namespaced apart
 * from the generation cell's own key (and therefore from any judge record
 * keyed the same way), so an OCSAI record and the LLM judge's record for the
 * same cell live under structurally different keys and can never collide,
 * overwrite, or be read back as though they were the same metric.
 */
export function ocsaiStoreKey(cellKey) {
  return `ocsai:${cellKey}`;
}

/**
 * Persist one cell's OCSAI result via lib/store.mjs's ResultsStore, as a
 * DISTINCT metric — issue #17: "Scores enter the store as a distinct metric,
 * never averaged with the LLM judge's axes." This never reads or merges into
 * any judge record; it only ever writes under ocsaiStoreKey(cellKey).
 *
 * @param {import("../../lib/store.mjs").ResultsStore} store
 * @param {string} cellKey        the generation cell's key (NOT re-derived — passed in).
 * @param {object} fields         { scores, cite, armId, briefId, replicate, cfg }
 */
export function putOcsaiScore(store, cellKey, { scores, cite, armId, briefId, replicate, cfg } = {}) {
  return store.put({
    key: ocsaiStoreKey(cellKey),
    result: { ocsai: { scores, cite } },
    resolvedModels: { judge: "ocsai" },
    accounting: { state: "completed" },
    costRows: [],
    armId,
    briefId,
    replicate,
    cfg,
  });
}
