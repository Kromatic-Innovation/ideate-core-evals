// sample.mjs — deterministic, reproducible sampling of LiveIdeaBench keywords for
// the scientific stratum (§3.2 of the pre-registration).
//
// ── Why "reproducible" needs more than "we picked 3 keywords" ──────────────────
// The acceptance criteria (issue #2) require recording the selection PROCEDURE
// and SEED, not just the result — because "we sampled 3 keywords" is not
// verifiable by a reader, while "sort this exact list, run this exact PRNG from
// this exact seed, take these draws" is. Anyone with the frozen keyword snapshot
// (./liveideabench-keywords.mjs) can re-run `sampleKeywords` and get byte-identical
// output. That is the whole point of pre-registering a study: a skeptical reader
// should be able to check the work, not just trust the write-up.
//
// ── Why a hand-rolled PRNG instead of Math.random() ─────────────────────────────
// Math.random() has no seed hook in the language — you cannot ask it to replay a
// draw. mulberry32 is a small, well-known, public-domain 32-bit PRNG (one line of
// state, ~5 lines of step function) that is trivially auditable and gives the same
// output on every Node version and every machine for a given numeric seed. We do
// not need cryptographic randomness here — we need REPRODUCIBLE randomness, which
// is a different requirement mulberry32 satisfies exactly.
//
// ── Why sort before sampling ────────────────────────────────────────────────────
// The keyword snapshot's array order is just the source CSV's row order, which is
// incidental (whatever order the LiveIdeaBench authors happened to write rows in).
// Sampling against an incidental order would make the result depend on a detail
// nobody registered. Sorting lexicographically first fixes a canonical order that
// is independent of the source file's formatting, so the selection procedure's
// only two degrees of freedom are the ones we DO register: the algorithm and the
// seed.

/**
 * mulberry32 — deterministic 32-bit PRNG. Public-domain algorithm (Tommy Ettinger).
 * Given the same `seed`, `next()` produces the same infinite sequence in
 * [0, 1) on any machine, any Node version, forever. That determinism is the
 * entire reason this function exists instead of `Math.random`.
 *
 * @param {number} seed  unsigned 32-bit integer seed
 * @returns {() => number} a `next()` function returning floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The registered selection procedure for the scientific stratum.
 *
 * Algorithm ("seeded partial Fisher–Yates draw without replacement"):
 *   1. De-duplicate the keyword list and sort it lexicographically (ascending,
 *      default JS string comparison) — this is the canonical order; see header.
 *   2. Seed mulberry32 with `seed`.
 *   3. Repeat `count` times: draw `next()`, map to an index into the REMAINING
 *      pool via `floor(next() * pool.length)`, remove that element from the
 *      pool and append it to the result (sampling without replacement).
 *
 * This is deterministic: same `keywords` + same `seed` + same `count` always
 * produces the same ordered output. See corpus.test.mjs
 * "seeded sampling is reproducible" for the property test, and
 * SCIENTIFIC_STRATUM_SAMPLE below for the frozen, registered result.
 *
 * @param {string[]} keywords  the candidate pool (will be de-duped + sorted; not mutated)
 * @param {number} count       how many to draw
 * @param {number} seed        unsigned 32-bit PRNG seed
 * @returns {string[]} the sampled keywords, in draw order
 */
export function sampleKeywords(keywords, count, seed) {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    throw new Error("sampleKeywords: keywords must be a non-empty array");
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("sampleKeywords: count must be a non-negative integer");
  }
  if (count > keywords.length) {
    throw new Error("sampleKeywords: count exceeds the size of the (de-duplicated) pool");
  }
  const sorted = [...new Set(keywords)].sort();
  const rng = mulberry32(seed);
  const pool = sorted.slice();
  const picked = [];
  for (let i = 0; i < count; i++) {
    const j = Math.floor(rng() * pool.length);
    picked.push(pool[j]);
    pool.splice(j, 1);
  }
  return picked;
}

// ── The registered draw for this study ──────────────────────────────────────
// Fixed once and frozen here so the corpus (index.mjs) does not need to
// re-run the sampler to know what it committed to. `corpus.test.mjs` asserts
// that re-running `sampleKeywords` with this exact seed reproduces this exact
// list from the frozen keyword snapshot — i.e. this constant is not an
// independent source of truth, it is a checked-in expectation.
export const SCIENTIFIC_SAMPLE_SEED = 20260731; // date this stratum was drawn, YYYYMMDD
export const SCIENTIFIC_SAMPLE_COUNT = 3;
export const SCIENTIFIC_SAMPLE_ALGORITHM =
  "seeded partial Fisher-Yates draw without replacement over the de-duplicated, " +
  "lexicographically-sorted LiveIdeaBench keyword list, using the mulberry32 PRNG";
