// storeConfig.mjs — resolve WHICH stored configHash an analysis run selects
// (issue #91).
//
// ── The defect this closes ──────────────────────────────────────────────────
// `lib/manifest.mjs` folds nine CONFIG_FIELDS into a `configHash`, and
// `frame.mjs` fits only cells whose stored `cfg` equals the hash of the
// config the CALLER declares. That is the never-silently-pool guarantee and
// it is load-bearing — nothing here weakens it.
//
// The problem was that `analysis.mjs` had no way to DECLARE the config the
// runner had actually written. It carried a flag for exactly one of the nine
// fields, so the hash it computed (`560d764366bc`) could never equal the one
// `evals/run.mjs` stamps onto every cell (`5ce5478956e5`). Every cell came
// back `stale`, `armLevels` came back `[]`, and the only symptom was a
// downstream complaint about `--reference-arm` — which reads as a bad
// argument, not as "your entire dataset was excluded".
//
// ── Why derive, rather than add eight more flags ────────────────────────────
// Flags would make the operator retype the runner's config by hand on every
// invocation, and a hand-copied config is a config that drifts. Worse, the
// two sides currently DISAGREE about the field set: `clusterDistanceThreshold`
// is a CONFIG_FIELDS entry that `analysis.mjs` set and `run.mjs` does not, so
// "just add the missing five flags" would have swapped one mismatch for
// another.
//
// So the analysis side stops computing a hash at all. It READS the `cfg`
// values the store's own index carries and selects one of them. There is no
// second derivation to drift from the first, and if `run.mjs` later starts
// stamping `clusterDistanceThreshold` (or drops a field, or gains one),
// nothing in evals/analysis/ needs to change to keep selecting its cells.
//
// ── Ambiguity is refused, never guessed ─────────────────────────────────────
// A store holding two configHashes holds two incomparable experiments. This
// module will NOT pick between them — not by cell count, not by recency.
// Picking is precisely the silent-pooling judgment call `lib/manifest.mjs`
// exists to forbid; the operator names the one they mean with
// `--config-hash`.
//
// ── Naming SEVERAL is allowed; guessing several is not (issue #168) ─────────
// `--config-hash` accepts a LIST. That is not a weakening of the rule above:
// the rule forbids this module CHOOSING, and a list is the operator choosing,
// out loud, in the invocation, where it is visible in the shell history and in
// any script that reproduces the run. Refusal is still the default — omitting
// the flag on a two-hash store throws exactly as before.
//
// It exists because `configHash` is deliberately COARSE. It folds nine
// CONFIG_FIELDS into one value, so a change to any of them stales every cell —
// including cells whose actual request bytes did not change at all. Stage 1c
// hit this: raising the max-effort output ceiling (issue #168) altered
// `promptHash`, and therefore the hash of all 432 cells, while leaving both
// solo control arms sending byte-identical requests (their resolved
// `max_tokens` is unchanged — 26250 and 6873 before and after, asserted in
// prompts.test.mjs so the claim is checked rather than argued). Re-collecting
// 288 physically-identical cells to make one hash string match is a cost with
// no measurement behind it.
//
// ── What pooling a list does NOT license ────────────────────────────────────
// Two of the nine CONFIG_FIELDS — `embedderId` and `clusterDistanceThreshold`
// — ARE the definition of `distinct_k`. Pooling across a change to either
// averages ideas counted by two different rulers and reports it as one number.
// So this flag is not "ignore the hash": the check stays, and the operator
// takes on the obligation to have established that what differs between the
// hashes they name does not touch the cells they are pooling. Dropping the
// comparison in `frame.mjs` outright would have been the same number of lines
// and would have made that failure unreachable from the type system AND
// invisible in the invocation.

/** Thrown when the store carries no usable `cfg` at all (empty store, or an
 *  index whose every entry predates cfg-stamping). Named so the CLI can say
 *  "there is nothing to analyze" instead of failing three modules later. */
export class NoStoredConfigError extends Error {
  constructor(resultsDir) {
    super(
      `resolveStoreConfigHash: no stored cell in '${resultsDir}' carries a configHash — ` +
        `there is nothing to analyze. Run evals/run.mjs against this store first.`,
    );
    this.name = "NoStoredConfigError";
  }
}

/** Thrown when the store holds MORE THAN ONE configHash and the operator did
 *  not say which one they meant. Carries the full tally so the message names
 *  every candidate rather than making the operator go read index.jsonl. */
export class AmbiguousStoredConfigError extends Error {
  constructor(resultsDir, tally) {
    const lines = tally.map((t) => `  ${t.cfg}  ${t.count} cell(s)  [${t.states.join(", ")}]`).join("\n");
    super(
      `resolveStoreConfigHash: store '${resultsDir}' holds ${tally.length} distinct configHashes — ` +
        `these are incomparable experiments and this tool will not choose between them ` +
        `(lib/manifest.mjs's never-silently-pool guarantee). Re-run with --config-hash <hash>, one of:\n${lines}`,
    );
    this.name = "AmbiguousStoredConfigError";
    this.tally = tally;
  }
}

/** Thrown when the operator named a configHash the store does not hold. This
 *  is the case that used to surface as `armLevels []`: every cell excluded as
 *  stale because the requested cfg matches nothing. Reported AS ITSELF here,
 *  at the point where the answer is knowable, with both the expected hash and
 *  what the store actually holds. */
export class UnknownStoredConfigError extends Error {
  constructor(resultsDir, requested, tally) {
    const held = tally.map((t) => `${t.cfg} (${t.count} cell(s))`).join(", ") || "nothing";
    super(
      `resolveStoreConfigHash: expected cfg ${requested}; store '${resultsDir}' holds ${held}. ` +
        `Every cell would be excluded as stale and 0 selected. ` +
        `Omit --config-hash to use the store's own configHash when it holds exactly one.`,
    );
    this.name = "UnknownStoredConfigError";
    this.requested = requested;
    this.tally = tally;
  }
}

/** The `cellKey()` grammar from lib/manifest.mjs, anchored.
 *
 *  A real `results/` store is SHARED: alongside study cells it holds records
 *  no analysis frame is about — per-judge-call records (key
 *  `judge-call|cell=…|judge=…`, whose `cfg` is the JUDGE MODEL ID, not a
 *  hash) and phase-0 validation records (key `phase0/…`, whose `cfg` is an
 *  OBJECT). Verified on the #8 smoke study's store, which holds four distinct
 *  `cfg` values of which exactly one is a configHash.
 *
 *  Those records are already harmless to `buildFrame()` — they fail the cfg
 *  comparison and land in `excluded.stale`. They are NOT harmless to a
 *  resolver, which would otherwise report a one-experiment store as four
 *  ambiguous ones and could in principle hand back a judge model id as if it
 *  were a config hash. So the tally counts study cells only: the key must
 *  parse as a cellKey, and its embedded cfg must agree with the index
 *  entry's. */
const CELL_KEY_RE = /^arm=(.+)\|brief=(.+)\|rep=(\d+)\|cfg=(.+)$/;

/** True if `key` is a study cell key carrying `cfg`. Exported because
 *  frame.mjs's NoCellsSelectedError needs the same filter to build its
 *  "store holds …" list — without it that message lists judge model ids
 *  as candidate config hashes on any real store. */
export function isStudyCellKey(key, cfg) {
  const m = CELL_KEY_RE.exec(key || "");
  return Boolean(m) && m[4] === cfg;
}

/**
 * Tally the distinct configHashes the store's STUDY CELLS carry.
 *
 * Entries with no string `cfg` are skipped rather than counted under
 * `undefined`: `ResultsStore.put()` does not validate `record.cfg`, so a
 * malformed writer could produce one, and letting it become a *candidate*
 * would be worse than ignoring it — nothing downstream can compare against a
 * hash that isn't one.
 *
 * @param {import("../../lib/store.mjs").ResultsStore} store
 * @returns {Array<{cfg: string, count: number, states: string[]}>} sorted by
 *   cfg, so the tally (and every message built from it) is deterministic.
 */
export function tallyStoredConfigs(store) {
  const byCfg = new Map();
  for (const entry of store.list()) {
    if (typeof entry.cfg !== "string" || entry.cfg === "") continue;
    if (!isStudyCellKey(entry.key, entry.cfg)) continue;
    if (!byCfg.has(entry.cfg)) byCfg.set(entry.cfg, { cfg: entry.cfg, count: 0, states: new Set() });
    const t = byCfg.get(entry.cfg);
    t.count += 1;
    if (entry.state) t.states.add(entry.state);
  }
  return Array.from(byCfg.values())
    .sort((a, b) => (a.cfg < b.cfg ? -1 : a.cfg > b.cfg ? 1 : 0))
    .map((t) => ({ cfg: t.cfg, count: t.count, states: Array.from(t.states).sort() }));
}

/**
 * The configHash this analysis run should select cells under.
 *
 * @param {import("../../lib/store.mjs").ResultsStore} store
 * @param {object} [opts]
 *   @param {string|string[]} [opts.configHash]  operator's explicit choice
 *     (`--config-hash`). Validated against the store: naming a hash the store
 *     does not hold is an error HERE, not an empty frame later. A LIST pools
 *     the named hashes — see "Naming SEVERAL is allowed" above for what that
 *     does and does not license. EVERY named hash is validated, so a typo in
 *     the second of two is caught with the same message as a typo in the
 *     first; a list that names the same hash twice is de-duplicated rather
 *     than double-counting its cells.
 *   @param {string} [opts.resultsDir]  only for error messages.
 * @returns {{configHash: string, configHashes: string[],
 *            tally: ReturnType<typeof tallyStoredConfigs>}}
 *   `configHashes` is always the full selected set. `configHash` is the single
 *   selected hash, kept for the (overwhelmingly common) one-hash case and for
 *   callers that predate the list form; when several are pooled it carries the
 *   first, and any message built from it alone would understate the selection,
 *   so downstream reporting should prefer `configHashes`.
 */
export function resolveStoreConfigHash(store, opts = {}) {
  const resultsDir = opts.resultsDir || (store && store.dir) || "<store>";
  const tally = tallyStoredConfigs(store);

  const requested = opts.configHash === undefined || opts.configHash === null ? [] : [].concat(opts.configHash);
  const named = Array.from(new Set(requested.filter((h) => typeof h === "string" && h !== "")));

  if (named.length) {
    // Validate EVERY named hash, not just the first miss: an operator pooling
    // two hashes has typed two 12-hex strings, and reporting only the first
    // bad one costs them a second round trip to find the second.
    const missing = named.filter((h) => !tally.some((t) => t.cfg === h));
    if (missing.length) throw new UnknownStoredConfigError(resultsDir, missing.join(", "), tally);
    return { configHash: named[0], configHashes: named, tally };
  }

  if (tally.length === 0) throw new NoStoredConfigError(resultsDir);
  if (tally.length > 1) throw new AmbiguousStoredConfigError(resultsDir, tally);
  return { configHash: tally[0].cfg, configHashes: [tally[0].cfg], tally };
}
