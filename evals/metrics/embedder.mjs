// embedder.mjs — the embedder interface every metric in this directory
// depends on, plus the two concrete implementations: a hermetic FIXTURE
// lookup (used by tests and negative controls) and a documented, unimplemented
// Voyage-4-lite stub (the production embedder, per docs/PREREGISTRATION.md
// §8.1 — "Voyage-4-lite embeddings").
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
 * The PRODUCTION embedder stub — Voyage-4-lite (API), per
 * docs/PREREGISTRATION.md §8.1 ("Voyage-4-lite embeddings", $0.02/MTok + 200M
 * free tokens/account). Deliberately UNIMPLEMENTED here: this issue (#3)
 * scopes the metric machinery and its hermetic validation, not a live network
 * client. Calling `.embed()` throws rather than silently returning garbage or
 * quietly falling back to the fixture embedder — a metrics module that
 * silently swapped embedders on missing credentials would produce numbers
 * that LOOK like a real run and aren't.
 *
 * ── What wiring this up for real requires (follow-up work, not in #3) ──────
 *   - A `VOYAGE_API_KEY` (or similar) env var, read here, never hardcoded.
 *   - A batched HTTP client honoring Voyage's rate limits / batch endpoint.
 *   - Feeding `input_tokens` into the accounting ledger (lib/accounting.mjs
 *     `costRow`) the same way generation calls do — embeddings are billed too.
 *   - Its OWN run-time DAT check (see this module's file-level deviation
 *     note below) — the hermetic DAT replication in ../dat-replication.test.mjs
 *     validates the FIXTURE embedder + the metric machinery, not this one.
 *     Voyage-4-lite could in principle fail to recover DAT ordering even
 *     though MiniLM does; nothing in this repo currently checks that, and
 *     that gap is a stated limitation (see PR body), not a hidden one.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiKey]  never invented/defaulted — must be supplied
 *   explicitly (e.g. from process.env.VOYAGE_API_KEY by the caller) so a
 *   missing key fails at construction, not deep inside a run.
 */
export function voyageEmbedder(opts = {}) {
  const { apiKey } = opts;
  return {
    modelId: "voyage-4-lite",
    dim: null, // unknown until implemented; Voyage-4-lite's published dim, not guessed here
    async embed(_texts) {
      throw new Error(
        "voyageEmbedder: not implemented. This is a documented interface stub (issue #3 scopes the " +
          "metric machinery + hermetic fixture embedder only). Implementing this requires a live " +
          "Voyage API client, a VOYAGE_API_KEY, and its own run-time DAT validity check — see this " +
          "function's header comment. apiKey supplied: " +
          (apiKey ? "yes (unused — stub)" : "no"),
      );
    },
  };
}
