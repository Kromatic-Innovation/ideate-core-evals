// embedder.mjs — the embedder interface every metric in this directory
// depends on, plus the two concrete implementations: a hermetic FIXTURE
// lookup (used by tests and negative controls) and the live Voyage-4-lite
// HTTP client (the production embedder, per docs/PREREGISTRATION.md §8.1 —
// "Voyage-4-lite embeddings").
//
// ── Why the metrics take embeddings, not text ───────────────────────────────
// distinct_k, poolDiversity, and collapseRate (./clustering.mjs,
// ./diversity.mjs) are defined purely in terms of vectors and a distance
// function. Keeping the embedding step OUTSIDE those functions is what makes
// them embedder-agnostic: the same clustering/diversity code runs unchanged
// whether the vectors came from the hermetic fixture lookup (tests, CI,
// negative controls) or the real Voyage-4-lite API (production runs). This
// mirrors `lib/manifest.mjs`'s `embedderId` CONFIG_FIELDS entry — swapping
// embedders is a config change that changes comparability, not a code change.
//
// ── The embedder interface ──────────────────────────────────────────────────
//   embed(texts: string[]) -> Promise<number[][]>
// One vector per input text, same order, L2-normalized (cosine distance is
// then just 1 - dot product, which every function in this directory assumes).
//
// ── Hermetic-CI safety: voyageEmbedder is network-capable, never network-eager ──
// `voyageEmbedder()` never imports an SDK and never calls fetch at
// construction or module-load time — only `.embed()` does, and only when
// actually invoked with a real `fetchImpl`. Tests exercise the real batching/
// ordering/normalization/usage-accounting logic by injecting a FAKE
// `fetchImpl` (see embedder.test.mjs), so `node --test` never makes a live
// network call even though this module is the production HTTP client. The
// live path is exercised only by ./live-validation.mjs, an opt-in script no
// test imports (see that file's header).

/**
 * The hermetic embedder: a pure text -> vector LOOKUP over a committed JSON
 * fixture (./fixtures/embeddings.json), generated ONCE by ./regen-fixtures.mjs
 * from real @huggingface/transformers (Xenova/all-MiniLM-L6-v2) output — see
 * that script's header for why hand-authored or hash-derived vectors are
 * explicitly disallowed here.
 *
 * ── Why it THROWS on an unknown text ────────────────────────────────────────
 * A control is only a control if it cannot silently embed something it
 * doesn't recognize. If this embedder fell back to a zero vector, a random
 * vector, or (worse) a hash-derived pseudo-embedding for unknown text, a typo
 * in a control's fixture text would silently degrade into "embeds as some
 * arbitrary vector" instead of failing loudly — exactly the "rigged control"
 * failure mode the issue warns about ("A control whose embedder is rigged to
 * pass is worse than not shipping"). So: known text -> its real vector;
 * unknown text -> a thrown error naming the offending string, always.
 *
 * @param {object} fixtures  the parsed embeddings.json payload (injected so
 *   tests can construct a small in-memory fixture set without touching disk;
 *   see clustering.test.mjs / diversity.test.mjs for that pattern)
 * @returns {{ embed: (texts: string[]) => Promise<number[][]>, modelId: string, dim: number }}
 */
export function fixtureEmbedder(fixtures) {
  if (!fixtures || typeof fixtures !== "object" || !fixtures.vectors) {
    throw new Error("fixtureEmbedder: fixtures must be a parsed embeddings.json payload with a `vectors` map");
  }
  return {
    modelId: fixtures.modelId,
    dim: fixtures.dim,
    async embed(texts) {
      if (!Array.isArray(texts) || texts.length === 0) {
        throw new Error("fixtureEmbedder.embed: texts must be a non-empty array");
      }
      return texts.map((text) => {
        const vec = fixtures.vectors[text];
        if (!vec) {
          throw new Error(
            `fixtureEmbedder.embed: no fixture vector for text ${JSON.stringify(text.slice(0, 80))} — ` +
              "the hermetic embedder only knows the frozen control/DAT texts in " +
              "./fixtures/control-texts.mjs. Add the text there and re-run regen-fixtures.mjs " +
              "rather than letting it embed as an arbitrary fallback vector (that would silently " +
              "defeat the negative control the text is used in).",
          );
        }
        return vec;
      });
    },
  };
}

/**
 * The PRODUCTION embedder — Voyage-4-lite (API), per docs/PREREGISTRATION.md
 * §8.1 ("Voyage-4-lite embeddings", $0.02/MTok + 200M free tokens/account).
 *
 * ── Construction never requires a key ───────────────────────────────────────
 * `voyageEmbedder()` (no args, no key) must NOT throw — run.mjs constructs
 * one just to read `.modelId` for configHash (see run.mjs main()), and a
 * --dry-run invocation must never touch the network or demand credentials
 * just to look up a model id string. The key is only required at `.embed()`
 * call time (see below) — construction-time failure would be surprising for
 * a pure "what model id would this run use" query.
 *
 * ── embed() fails loudly, never silently degrades ───────────────────────────
 * Calling `.embed()` with no apiKey throws immediately, before any network
 * call — never invents/defaults a key, and never silently falls back to the
 * hermetic fixture embedder. A metrics module that quietly swapped embedders
 * on missing credentials would produce numbers that LOOK like a real run and
 * aren't, which is worse than an obvious crash (see ./fixtureEmbedder's own
 * "throws on unknown text" reasoning above — same honesty principle, applied
 * to credentials instead of vocabulary).
 *
 * ── Batching, ordering, normalization ───────────────────────────────────────
 * Texts are chunked into groups of `batchSize` (Voyage's own batch limit is
 * generous, but chunking bounds any single request's payload/latency and
 * keeps retry blast-radius small). Each chunk is POSTed independently; the
 * response's `data[].index` is honored explicitly (sorted before reassembly)
 * rather than trusting response order to match request order, since nothing
 * in Voyage's docs guarantees that and every function in this directory
 * (clustering.mjs, diversity.mjs) assumes strict input-order correspondence.
 * Every returned vector is L2-normalized defensively — Voyage returns unit
 * vectors by default, but re-normalizing here costs nothing and removes an
 * entire class of "was this actually unit-length" doubt from every
 * downstream cosineDistance call (see clustering.mjs cosineDistance, which
 * itself re-divides by magnitude for the same defensive reason).
 *
 * ── Usage accounting ─────────────────────────────────────────────────────
 * `usage.total_tokens` is accumulated across chunks onto the returned
 * embedder's `.usage.total_tokens` so a future metrics-run can ledger it the
 * way lib/accounting.mjs costRow() ledgers generation calls. This function
 * does NOT wire into lib/accounting.mjs itself — no metrics-run pipeline
 * consumes embedder usage yet; wiring it in is follow-up work, not invented
 * here.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiKey]  never invented/defaulted — must be supplied
 *   explicitly (e.g. from process.env.VOYAGE_API_KEY by the caller) so a
 *   missing key fails at the FIRST embed() call, not deep inside a batch.
 * @param {typeof fetch} [opts.fetchImpl]  injected fetch, defaulting to
 *   globalThis.fetch — the seam that keeps this hermetic-safe: tests inject a
 *   fake that never touches the network, so importing this module (even
 *   calling voyageEmbedder() to read .modelId) never risks a live call. Only
 *   an actual `.embed()` invocation with a real fetchImpl reaches the network.
 * @param {string} [opts.model]  Voyage model id, default "voyage-4-lite" per
 *   §8.1 — also becomes `.modelId`, which feeds lib/manifest.mjs configHash.
 * @param {number} [opts.batchSize]  texts per HTTP request, default 128.
 * @param {string} [opts.inputType]  optional Voyage `input_type` ("query" |
 *   "document") — omitted from the request body entirely when not supplied,
 *   matching Voyage's own "omit for symmetric use" default behavior.
 */
export function voyageEmbedder(opts = {}) {
  const { apiKey, fetchImpl = globalThis.fetch, model = "voyage-4-lite", batchSize = 128, inputType } = opts;

  const embedder = {
    modelId: model,
    dim: null, // unknown until the first live response; Voyage-4-lite's published dim, not guessed here
    usage: { total_tokens: 0 },
    async embed(texts) {
      if (!Array.isArray(texts) || texts.length === 0) {
        throw new Error("voyageEmbedder.embed: texts must be a non-empty array");
      }
      if (!apiKey) {
        throw new Error(
          "voyageEmbedder.embed: no API key supplied. Set VOYAGE_API_KEY in the environment and pass " +
            "it explicitly as voyageEmbedder({ apiKey: process.env.VOYAGE_API_KEY }) — this module never " +
            "invents or defaults a key, and never silently falls back to the hermetic fixture embedder.",
        );
      }

      // Preallocate so out-of-order chunk resolution (shouldn't happen since
      // chunks are awaited sequentially below, but keeps the invariant
      // explicit) can't scramble which output slot a chunk's vectors land in.
      const results = new Array(texts.length);

      for (let start = 0; start < texts.length; start += batchSize) {
        const chunk = texts.slice(start, start + batchSize);
        const body = {
          input: chunk,
          model,
          ...(inputType ? { input_type: inputType } : {}),
        };

        const res = await fetchImpl("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "<unreadable body>");
          throw new Error(`voyageEmbedder.embed: Voyage API returned ${res.status} ${res.statusText}: ${text}`);
        }

        const payload = await res.json();
        if (!payload || !Array.isArray(payload.data)) {
          throw new Error("voyageEmbedder.embed: malformed Voyage API response (missing `data` array)");
        }
        if (payload.data.length !== chunk.length) {
          throw new Error(
            `voyageEmbedder.embed: expected ${chunk.length} embeddings for this batch, got ${payload.data.length}`,
          );
        }

        // Sort by the server's own `index` before reassembly — never trust
        // response array order to match request order (see header comment).
        const sorted = [...payload.data].sort((a, b) => a.index - b.index);
        sorted.forEach((row, i) => {
          const vec = l2Normalize(row.embedding);
          results[start + i] = vec;
          if (embedder.dim === null) embedder.dim = vec.length;
        });

        if (payload.usage && Number.isFinite(payload.usage.total_tokens)) {
          embedder.usage.total_tokens += payload.usage.total_tokens;
        }
      }

      return results;
    },
  };

  return embedder;
}

/**
 * L2-normalize a vector in place-safe fashion (returns a new array). Applied
 * defensively to every vector voyageEmbedder returns — see that function's
 * header for why re-normalizing known-unit vectors is cheap insurance rather
 * than redundant work.
 *
 * @param {number[]} vec
 * @returns {number[]}
 */
function l2Normalize(vec) {
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) {
    throw new Error("voyageEmbedder: received a zero-magnitude embedding vector, cannot normalize");
  }
  return vec.map((x) => x / norm);
}
