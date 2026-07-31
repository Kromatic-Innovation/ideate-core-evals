// order.mjs — deterministic, seeded presentation-order randomization for
// judge calls (issue #4, AC4).
//
// ── Why randomize at all ─────────────────────────────────────────────────────
// A judge that always sees candidates in the same order (e.g. the order the
// generating arm happened to emit them in) risks a position bias confounding
// with arm/model identity — exactly the kind of uncontrolled variable
// docs/PREREGISTRATION.md §5's de-identification requirement exists to rule
// out (see ./deidentify.mjs). Randomizing presentation order per judge call
// removes "which slot in the list" as a systematic signal.
//
// ── Why an explicit seed rather than Math.random() ──────────────────────────
// The whole study is built around REPLAYABILITY: `lib/manifest.mjs`'s
// cellKey/configHash design exists so "did I already run this exact
// measurement" has an exact answer, and `lib/store.mjs` is append-only so a
// resumed run reproduces prior cells' inputs exactly. An unseeded
// Math.random() order would make a re-run of "the same call" silently
// non-reproducible — impossible to unit test deterministically, and, if a
// judge call ever needs re-issuing (retry after transport error), a source of
// unaccounted variance between the original and the retry. An explicit
// integer seed makes "the same seed reproduces the exact same ordering" a
// provable property (see order.test.mjs) rather than a hope.
//
// ── mulberry32 + Fisher-Yates, inline, no dependency ────────────────────────
// This repo has ZERO runtime dependencies. mulberry32 is a tiny, well-known
// 32-bit PRNG (public domain) chosen for exactly two properties: (1) it is a
// handful of lines, so vendoring it inline is cheaper and more auditable than
// adding a package; (2) it is fully deterministic from a single 32-bit
// integer seed, which is all `orderCandidates` needs. It is NOT
// cryptographically secure and must never be used for anything security-
// sensitive — its only job here is a reproducible shuffle.

/**
 * mulberry32: seeded 32-bit PRNG. Returns a function that yields the next
 * pseudo-random float in [0, 1) on each call, advancing its own internal
 * state — i.e. the SAME `seed` always produces the SAME sequence of outputs.
 * @param {number} seed  a 32-bit integer seed
 * @returns {() => number}
 */
function mulberry32(seed) {
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
 * Randomize presentation order for one judge call, deterministically from an
 * explicit integer seed. Fisher-Yates (Durstenfeld variant) over a COPY of
 * `candidates` — the input array is never mutated, matching this codebase's
 * general "never mutate what you were handed" convention (see
 * lib/store.mjs's append-only discipline, deidentify.mjs's non-mutation).
 *
 * @param {Array} candidates  the pool to reorder (any element type)
 * @param {number} seed        explicit integer seed; REQUIRED — there is no
 *   silent fallback to system randomness, for the replayability reasons in
 *   the header above.
 * @returns {Array} a new array: the same elements, permuted
 */
export function orderCandidates(candidates, seed) {
  if (!Array.isArray(candidates)) {
    throw new Error("orderCandidates: candidates must be an array");
  }
  if (!Number.isInteger(seed)) {
    throw new Error(`orderCandidates: seed must be an explicit integer, got ${JSON.stringify(seed)} — an unseeded shuffle can't be replayed`);
  }
  const out = candidates.slice();
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
