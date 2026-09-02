// store.mjs — the append-only results store backing the additive design (#6).
//
// ── Why this exists ─────────────────────────────────────────────────────────
// `lib/manifest.mjs` computes `planRun(spec, storedKeys)` — todo/reuse/stale —
// against a list of keys it is handed. This module IS the thing that produces
// that list, and the thing that persists what a completed cell actually
// measured. The two modules have a strict contract: manifest.mjs never reads
// a file and never knows the store's on-disk shape; this module never
// computes a cell key or a config hash — it only stores/retrieves records
// under whatever key `cellKey()` produced.
//
// ── Two files per cell, on purpose (the load-bearing design decision) ───────
// `planRun` is called on every run, including runs that touch none of the
// existing cells (e.g. "did the 40 cells from last week already run?" before
// launching 4 new ones). At 400+ cells, and payloads that can carry full
// provider replies (potentially large, per docs/PREREGISTRATION.md — "raw
// provider replies are large and may echo brief text under NDA"), reading
// every body just to answer "which keys exist" would make the additive
// design expensive exactly where it needs to be cheap.
//
// So the index and the bodies are split:
//   index.jsonl        — one JSON line per record: {key, bodyFile, state,
//                         armId, briefId, replicate, cfg, storedAt}. Small,
//                         fixed-shape, safe to read in full on every run.
//   bodies/<hash>.json  — one file per cell: {key, result, resolvedModels,
//                         accounting, costRows}. Read only via get(key), and
//                         only for the specific keys a caller actually needs
//                         (e.g. rendering a report), never to answer "what
//                         keys exist".
// `keys()` / `has()` / `list()` read ONLY index.jsonl. `get()` is the only
// method that touches bodies/.
//
// ── Append-only, never mutated ───────────────────────────────────────────────
// The `stale` path in planRun depends on a prior cell surviving, unchanged,
// under its old config hash once a NEW cell exists under the new one. A store
// that overwrote on re-measurement would destroy exactly the comparison the
// stale flag exists to enable. So:
//   - put() for a key that is NOT yet in the index: writes the body, then
//     appends the index line (in that order — see "atomicity" below).
//   - put() for a key that IS already in the index: allowed ONLY if the new
//     record serializes byte-identical to the stored one (a verified
//     no-op — the common case is a caller re-running a cell it already
//     believes is `todo` because it crashed after storing but before
//     recording the outcome upstream). Any actual difference throws. This
//     repo picks "verified no-op over blind reject" so a harness restart
//     after a partial crash doesn't need special-cased recovery logic; it
//     is exercised in store.test.mjs under both names.
//
// ── The ONE removal path: remove() (issue #98) ──────────────────────────────
// "Append-only" above is a statement about `put()`: no key's content is ever
// rewritten, and that is still absolute. It was ALSO, until #98, a statement
// about the store as a whole — nothing could take a record out. That second
// property turned out to be a defect rather than a guarantee:
//
//   - A store written before #90 holds TRANSIENT generation failures (a 429,
//     a timeout, an empty credit balance) under `cell.key`. `planRun` sees
//     only keys, so it classifies them `reuse` forever. With no removal path
//     the only remedies were "bump the configHash and re-plan every cell" or
//     "hand-edit index.jsonl", and the docs had to say so out loud.
//   - Attempt records (`generation-attempt|cell=…|attempt=N`) exist precisely
//     so a failed cell's SPEND outlives the cell. A deterministic transient
//     cause appends one every invocation, and `spendToDate()` parses every
//     stored body — so an unbounded pile makes every ceiling-gated run
//     slower, forever.
//
// So `remove(keys, opts)` exists, and it is the ONLY method that unlinks
// anything. It is deliberately narrow and deliberately awkward:
//
//   1. It takes an explicit list of exact keys. There is no predicate, no
//      glob, no "remove everything matching". Whoever removes a record has
//      already named it.
//   2. It REFUSES a `completed` record unless the caller passes
//      `{ allowCompleted: true }`. A completed cell is paid-for data; a
//      silent delete of one is worse than any bug removal was added to fix.
//   3. It throws on a key the index does not hold, rather than shrugging.
//   4. It never reprices or rewrites anything. Removal does NOT preserve the
//      removed record's cost rows — this module has no idea what a cost row
//      means. Preserving spend is the CALLER's obligation, and the caller
//      that does it is `pruneStore()` in evals/harness/runner.mjs: it
//      re-homes an evicted cell's `costRows` under an attempt-scoped key
//      BEFORE removing the cell, and verifies `spendToDate()` is unchanged
//      afterwards. Anything else calling remove() must do the same or
//      knowingly discard money.
//
// What did NOT change: `put()` still refuses to overwrite. A re-measurement
// still belongs under a new key. `stale` still works, because removal is
// never something a RUN does — it is an explicitly-invoked operator
// command (`node evals/run.mjs --prune --apply`), and nothing on the normal
// run path calls it.
//
// ── Atomicity (best-effort, not transactional) ───────────────────────────────
// Node stdlib has no cross-file transaction. The ordering below is chosen so
// that any crash leaves the store in a SAFE state — never an index entry
// pointing at a missing/partial body — at the cost of a possible orphaned
// body file (harmless: it's just never indexed, and a retried put() with the
// same key+content is the byte-identical no-op above, not a duplicate).
//   1. Body written to a temp file in bodies/, then fs.renameSync into place
//      (rename is atomic on the same filesystem — no reader ever observes a
//      partially-written body).
//   2. Index line appended with fs.appendFileSync (POSIX guarantees an
//      append() of a single write() below PIPE_BUF is atomic w.r.t. other
//      appends; index lines here are well under that).
// If the process dies between (1) and (2), the body exists but is unindexed
// — invisible to keys()/get(), exactly as if put() had never been called.
//
// `remove()` inverts the ordering for the same reason, and the inversion is
// load-bearing:
//   1. index.jsonl rewritten (tmp + rename) WITHOUT the removed lines.
//   2. THEN the body files are unlinked.
// A crash between the two leaves an orphaned body — harmless, invisible,
// identical to the put() crash window. The opposite order would leave an
// index line pointing at a body that no longer exists, and `spendToDate()`
// throws hard on exactly that (see its catch block), i.e. a crash would
// brick every ceiling-gated run until someone hand-repaired the index. Same
// principle as put(): the safe direction is "a body nothing points at",
// never "a pointer to no body".
//
// ── Directory is configurable, never hardcoded to results/ ──────────────────
// `results/` is gitignored (see .gitignore) and is where the real store
// lives, but every method here takes the directory as a constructor arg so
// tests point at a temp dir instead.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const INDEX_FILE = "index.jsonl";
const BODIES_DIR = "bodies";

/** sha256(key), hex, truncated to 16 chars — a filesystem-safe body filename.
 *  Truncated (not the full digest) purely for shorter paths; 64 bits is
 *  vastly more than enough collision resistance for a per-study cell count
 *  that will never approach the birthday bound. Collisions are additionally
 *  guarded against explicitly in put() (see the collision check there). */
function bodyFileFor(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16) + ".json";
}

/** Canonical JSON: sorted keys, so two structurally-equal records always
 *  serialize identically regardless of property insertion order. This is
 *  what makes the "byte-identical no-op" comparison in put() meaningful —
 *  without it, the same logical record built twice could differ only in key
 *  order and be wrongly rejected as a mutation attempt. */
function canonicalStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

/**
 * An append-only, on-disk results store.
 *
 * @param {string} dir — root directory for this store's index + bodies.
 *   Created (recursively) if it doesn't exist. Tests should pass a temp
 *   dir; production code should pass the configured `results/` path —
 *   never hardcode it here.
 */
export class ResultsStore {
  constructor(dir) {
    if (!dir || typeof dir !== "string") {
      throw new Error("ResultsStore: dir is required — the store never assumes a default location (results/ is gitignored and per-deployment)");
    }
    this.dir = dir;
    this.bodiesDir = join(dir, BODIES_DIR);
    this.indexPath = join(dir, INDEX_FILE);
    mkdirSync(this.bodiesDir, { recursive: true });
    if (!existsSync(this.indexPath)) writeFileSync(this.indexPath, "");
    this._indexCache = null; // Map<key, entry> — lazily built, invalidated on put()
  }

  /** Read index.jsonl in full and build key -> entry. THE cheap path: no
   *  body file is opened. Cached in memory for the lifetime of this store
   *  instance; invalidated whenever put() appends a new line, and rebuilt
   *  lazily (not eagerly, so opening a store you only intend to write to
   *  doesn't pay a read it'll never use). */
  #loadIndex() {
    if (this._indexCache) return this._indexCache;
    const map = new Map();
    const text = readFileSync(this.indexPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      map.set(entry.key, entry);
    }
    this._indexCache = map;
    return map;
  }

  /** Every stored key. This is what feeds `planRun(spec, store.keys())` —
   *  reads ONLY index.jsonl, regardless of how large the bodies are or how
   *  many cells are stored. */
  keys() {
    return Array.from(this.#loadIndex().keys());
  }

  /** True if `key` has a completed record. Index-only, same as keys(). */
  has(key) {
    return this.#loadIndex().has(key);
  }

  /** Index metadata for every stored cell (key, state, arm/brief/replicate/
   *  cfg, storedAt) WITHOUT reading any body. Useful for a dashboard/report
   *  that wants to slice by arm or state without paying for full payloads. */
  list() {
    return Array.from(this.#loadIndex().values()).map((e) => ({ ...e }));
  }

  /**
   * Full record for one cell: { key, result, resolvedModels, accounting,
   * costRows }. The only method that reads a body file, and it reads
   * exactly one.
   */
  get(key) {
    const entry = this.#loadIndex().get(key);
    if (!entry) throw new Error(`ResultsStore.get: no stored record for '${key}'`);
    const raw = readFileSync(join(this.bodiesDir, entry.bodyFile), "utf8");
    return JSON.parse(raw);
  }

  /**
   * Append one completed cell's record. Append-only: see the header for the
   * full invariant. Throws on any attempt to change an existing key's
   * content; is a verified no-op if the incoming record is byte-identical
   * to what's already stored.
   *
   * @param {object} record
   *   @param {string} record.key            the exact cellKey() string
   *   @param {object} record.result         full result payload
   *   @param {object} record.resolvedModels arm's resolved model IDs, e.g.
   *                                          { proposer: "claude-haiku-4-5", ... }
   *   @param {object} record.accounting     terminal state for this cell —
   *                                          { state, kind?, detail? }, the
   *                                          same shape RunAccount tracks
   *                                          per-key in lib/accounting.mjs
   *   @param {Array}  record.costRows       costRow() objects for this cell
   *                                          (lib/accounting.mjs schema —
   *                                          tokens x model x timestamp x
   *                                          billing_mode; NEVER cost_usd)
   */
  put(record) {
    const { key, result, resolvedModels, accounting, costRows } = record || {};
    if (!key || typeof key !== "string") {
      throw new Error("ResultsStore.put: record.key is required (the exact cellKey() string)");
    }
    if (!result || typeof result !== "object") {
      throw new Error(`ResultsStore.put('${key}'): record.result is required — a stored cell with no payload is a silent drop wearing a success label`);
    }
    if (!resolvedModels || typeof resolvedModels !== "object") {
      throw new Error(`ResultsStore.put('${key}'): record.resolvedModels is required — the whole point of storing resolved IDs is knowing exactly what ran`);
    }
    if (!accounting || typeof accounting !== "object" || !accounting.state) {
      throw new Error(`ResultsStore.put('${key}'): record.accounting (with a .state) is required — a stored cell must carry its terminal state`);
    }
    if (!Array.isArray(costRows)) {
      throw new Error(`ResultsStore.put('${key}'): record.costRows must be an array (may be empty, e.g. a 'skipped' cell — but the field must be present)`);
    }
    for (const row of costRows) {
      if ("cost_usd" in row || "notional_usd" in row) {
        // Belt-and-suspenders: costRow() in lib/accounting.mjs already
        // refuses to construct such a row, but the store doesn't assume its
        // caller used that helper — a stored dollar figure is exactly the
        // un-repriceable defect this whole ledger schema exists to prevent.
        throw new Error(`ResultsStore.put('${key}'): cost rows must never carry a dollar figure (cron-fleet#75) — record tokens x model x timestamp instead`);
      }
    }

    const body = { key, result, resolvedModels, accounting, costRows };
    const bodyFile = bodyFileFor(key);
    const bodyPath = join(this.bodiesDir, bodyFile);
    const canonical = canonicalStringify(body);

    const existingEntry = this.#loadIndex().get(key);
    if (existingEntry) {
      // Collision guard: two DIFFERENT keys must never share a bodyFile.
      // (sha256-16 collision is astronomically unlikely for a study-sized
      // key set, but the check is cheap and the failure mode it prevents —
      // silently overwriting an unrelated cell's body — is exactly the
      // mutation this store exists to forbid.)
      if (existingEntry.bodyFile !== bodyFile) {
        throw new Error(`ResultsStore.put('${key}'): index/body-file mismatch — refusing to write (possible corruption)`);
      }
      const priorRaw = readFileSync(bodyPath, "utf8");
      if (priorRaw === canonical) {
        return { key, written: false, reason: "byte-identical no-op" };
      }
      throw new Error(
        `ResultsStore.put('${key}'): a record already exists under this exact key with DIFFERENT content — ` +
          `the store is append-only. A re-measurement belongs under a NEW key (a new configHash), never an ` +
          `overwrite of this one; see lib/manifest.mjs's stale path.`,
      );
    }

    // Guard against a body-file collision with a DIFFERENT key that hasn't
    // hit this store instance's cache yet (e.g. a concurrent writer). Cheap
    // to check: at most one existsSync + read.
    if (existsSync(bodyPath)) {
      const priorRaw = readFileSync(bodyPath, "utf8");
      if (priorRaw !== canonical) {
        throw new Error(`ResultsStore.put('${key}'): body file '${bodyFile}' already exists with different content under a different key — hash collision or index corruption, refusing to write`);
      }
      // Byte-identical body already on disk but not yet indexed (e.g. a
      // crash between step 1 and step 2 of a prior put() for this exact
      // key/content) — fall through to append the index line so the
      // orphaned body becomes visible, rather than erroring.
    } else {
      // Write-then-rename: no reader ever observes a partial body file.
      const tmpPath = join(this.bodiesDir, `.tmp-${bodyFile}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      writeFileSync(tmpPath, canonical);
      renameSync(tmpPath, bodyPath);
    }

    const entry = {
      key,
      bodyFile,
      state: accounting.state,
      armId: record.armId,
      briefId: record.briefId,
      replicate: record.replicate,
      cfg: record.cfg,
      storedAt: record.storedAt || new Date().toISOString(),
    };
    appendFileSync(this.indexPath, JSON.stringify(entry) + "\n");
    this._indexCache.set(key, entry); // keep the in-memory cache consistent
    return { key, written: true };
  }

  /**
   * Remove one or more records. THE only removal path in this codebase — see
   * the "ONE removal path" section of the module header for why it exists,
   * what it deliberately refuses, and why preserving a removed record's
   * spend is the caller's job and not this method's.
   *
   * Nothing on the normal run path calls this. Its one production caller is
   * `pruneStore()` in evals/harness/runner.mjs, reached only via
   * `node evals/run.mjs --prune --apply`.
   *
   * @param {string[]} keys exact keys, as stored. No patterns, no predicates.
   * @param {object} [opts]
   *   @param {boolean} [opts.allowCompleted=false] permit removing a record
   *     whose indexed `state` is `completed`. Off by default and named
   *     explicitly at every call site that needs it: a completed cell is
   *     paid-for data.
   * @returns {{removed: string[], bodiesUnlinked: number}}
   * @throws if any key is absent, or if any key is `completed` and
   *   `allowCompleted` was not passed. Validation is done for the WHOLE list
   *   before anything is written, so a bad key in position 7 removes nothing
   *   rather than leaving a half-applied prune.
   */
  remove(keys, { allowCompleted = false } = {}) {
    if (!Array.isArray(keys)) {
      throw new Error("ResultsStore.remove: keys must be an array of exact stored keys (there is no predicate form — whoever removes a record names it)");
    }
    const index = this.#loadIndex();
    const targets = [...new Set(keys)];
    if (targets.length === 0) return { removed: [], bodiesUnlinked: 0 };

    // ── Validate the entire batch first, mutate nothing ─────────────────
    const missing = targets.filter((k) => !index.has(k));
    if (missing.length) {
      throw new Error(
        `ResultsStore.remove: ${missing.length} key(s) are not in the index — refusing to remove anything. ` +
          `A caller that does not know what the store holds should not be deleting from it. Unknown: ` +
          missing.slice(0, 5).map((k) => `'${k}'`).join(", ") + (missing.length > 5 ? `, …(+${missing.length - 5})` : ""),
      );
    }
    const completed = targets.filter((k) => index.get(k).state === "completed");
    if (completed.length && !allowCompleted) {
      throw new Error(
        `ResultsStore.remove: ${completed.length} of these key(s) are stored as 'completed' — paid-for measurements. ` +
          `Refusing without an explicit { allowCompleted: true } (the CLI spells this --allow-completed). ` +
          `Completed: ` + completed.slice(0, 5).map((k) => `'${k}'`).join(", ") + (completed.length > 5 ? `, …(+${completed.length - 5})` : ""),
      );
    }

    // ── 1. Rewrite the index WITHOUT the removed lines (tmp + rename) ─────
    // Order is preserved for every surviving line: the index is read back in
    // file order and callers (e.g. an operator reading index.jsonl) reason
    // about it chronologically.
    const doomed = new Set(targets);
    const survivors = [];
    for (const line of readFileSync(this.indexPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      if (doomed.has(JSON.parse(line).key)) continue;
      survivors.push(line);
    }
    const tmpIndex = join(this.dir, `.tmp-${INDEX_FILE}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmpIndex, survivors.length ? survivors.join("\n") + "\n" : "");
    renameSync(tmpIndex, this.indexPath);
    this._indexCache = null; // rebuilt lazily from the file we just rewrote

    // ── 2. THEN unlink the bodies ───────────────────────────────────
    // bodyFileFor() is sha256(key), so no two keys share a body file (and
    // put() explicitly refuses the collision case) — unlinking is safe.
    // `force: true` so a body already missing (an interrupted earlier
    // remove()) completes the cleanup instead of throwing.
    let bodiesUnlinked = 0;
    for (const key of targets) {
      const bodyPath = join(this.bodiesDir, bodyFileFor(key));
      if (existsSync(bodyPath)) {
        rmSync(bodyPath, { force: true });
        bodiesUnlinked += 1;
      }
    }
    return { removed: targets, bodiesUnlinked };
  }
}

// ── Attempt-record key grammar (issues #98, #108) ───────────────────────────
// These three live HERE, not in evals/harness/runner.mjs where the prune
// policy lives, for one structural reason: `evals/judge/gate.mjs`'s
// meterJudgeCall must derive the SAME next-attempt number that the prune's
// compaction assumes, and runner.mjs already imports gate.mjs transitively
// (runner -> evals/judge/score.mjs -> gate.mjs). gate.mjs importing back from
// runner.mjs would close an import cycle whose worst case is silent rather
// than loud: `ATTEMPT_FAMILIES` is a module-init `const`, so under the wrong
// cycle-entry order it reads `undefined` and parseAttemptKey returns null for
// every key -- attempt numbering would restart at 0 and collide.
//
// This module has no dependency on any other module in the repo, so both
// sides can import it freely. The functions are pure key-string parsing plus
// `store.keys()`; they know nothing about what a cost row means, which keeps
// the boundary this module's header draws intact. runner.mjs re-exports them
// so existing importers are unaffected.

/** Attempt-record families the prune COMPACTS, and that number their records
 *  with `|attempt=N`. `judge-call` joined in #108: its records have the same
 *  shape and the same unbounded-growth property, and were only held out of
 *  #98 because meterJudgeCall numbered attempts by COUNTING matching keys.
 *
 *  A judge-call key carries an extra `|judge=<model>` segment between the
 *  cell and the attempt number. That segment is NOT special-cased: the parse
 *  below splits on the LAST `|attempt=`, so a judge-call record's parsed
 *  `cellKey` is the composite `<cellKey>|judge=<model>` -- which is exactly
 *  the identity attempts are numbered and compacted per. One grammar, no
 *  per-family branch.
 *
 *  This list is the COMPACTION set specifically. `ATTEMPT_KEY_FAMILIES` below
 *  is the wider set that merely SHARES the key grammar -- see there for why
 *  the two had to come apart in #103. */
export const ATTEMPT_FAMILIES = ["generation-attempt", "metrics-attempt", "judge-call"];

/** The batch-resume record family (issue #103). Shares the attempt-key
 *  grammar -- `batch-replay|cell=<cellKey>|attempt=N` -- so it inherits
 *  `parseAttemptKey` and, critically, `nextAttemptNumber`'s max+1 discipline
 *  (never a count) exactly as the three compacted families do.
 *
 *  It is deliberately NOT in `ATTEMPT_FAMILIES`, and that separation is
 *  load-bearing rather than tidy. Compaction folds a family's records into
 *  one whose body is the SUM OF THEIR COST ROWS and nothing else. A
 *  batch-replay record's payload is not cost rows -- it is the durable batch
 *  handle and the recovered replies keyed by content-derived custom_id -- so
 *  compacting one would silently destroy exactly the handle resume exists to
 *  re-poll, converting this feature into a slower way to pay twice. So #103
 *  splits "families that use the key grammar" (this + ATTEMPT_FAMILIES, i.e.
 *  ATTEMPT_KEY_FAMILIES) from "families the prune compacts"
 *  (ATTEMPT_FAMILIES, unchanged), and `planPrune`'s compaction loop filters
 *  to the latter.
 *
 *  ── The invariant that makes this family safe to drop outright ──────────
 *  A batch-replay record ALWAYS carries `costRows: []`. Money never lives
 *  here: a recovered reply's tokens are metered exactly once, at the moment
 *  they are first observed, onto the generation cell or its
 *  `generation-attempt` record -- the two places `spendToDate()` already
 *  reads. `writeBatchResumeRecord` enforces the empty-cost-rows invariant
 *  rather than trusting its caller, because it is the whole reason a
 *  superseded replay record can be evicted with no salvage step (contrast
 *  `pruneStore`'s `salvageEvictedCellSpend`, which exists precisely because
 *  cell records DO carry money). */
export const BATCH_RESUME_FAMILY = "batch-replay";

/** Every family using the `family|cell=<cellKey>|attempt=N` key grammar --
 *  what `parseAttemptKey`/`nextAttemptNumber` parse and number over. A
 *  superset of `ATTEMPT_FAMILIES`; see `BATCH_RESUME_FAMILY` for why the two
 *  are not the same list. */
export const ATTEMPT_KEY_FAMILIES = [...ATTEMPT_FAMILIES, BATCH_RESUME_FAMILY];

/**
 * Parse a stored key as an attempt record of one of ATTEMPT_KEY_FAMILIES, raw
 * or compacted. Returns `{ family, cellKey, through, compacted }` or null.
 *
 * `through` is the HIGHEST attempt number the record accounts for — the
 * attempt number itself for a raw record, the fold's upper bound for a
 * compacted one. That single field is what makes ordering, next-number
 * derivation and crash recovery all work off one comparison.
 *
 * Parsed by suffix position, never by a greedy regex: the cell key sits in
 * the MIDDLE of these keys and itself contains `|` and `=`.
 */
export function parseAttemptKey(key) {
  for (const family of ATTEMPT_KEY_FAMILIES) {
    const rawPrefix = `${family}|cell=`;
    if (key.startsWith(rawPrefix)) {
      const at = key.lastIndexOf("|attempt=");
      if (at <= rawPrefix.length - 1) return null;
      const n = Number(key.slice(at + "|attempt=".length));
      if (!Number.isInteger(n) || n < 0) return null;
      return { family, cellKey: key.slice(rawPrefix.length, at), through: n, compacted: false };
    }
    const compactedPrefix = `${family}-compacted|cell=`;
    if (key.startsWith(compactedPrefix)) {
      const at = key.lastIndexOf("|through=");
      if (at <= compactedPrefix.length - 1) return null;
      const n = Number(key.slice(at + "|through=".length));
      if (!Number.isInteger(n) || n < 0) return null;
      return { family, cellKey: key.slice(compactedPrefix.length, at), through: n, compacted: true };
    }
  }
  return null;
}

/**
 * The next attempt number for `cellKey` in `family`: one past the highest
 * attempt any stored record accounts for, across BOTH the raw and compacted
 * shapes.
 *
 * This replaces the pre-#98 `store.keys().filter(startsWith).length` count,
 * and the replacement is required rather than cosmetic: once compaction
 * folds attempts 0..4 into a single record, a COUNT says "1 record, so the
 * next attempt is 1" — colliding with the retained attempt 5. Deriving from
 * the maximum is correct under every mix of folded and unfolded records, and
 * is identical to the old count for the un-compacted 0..n-1 case.
 *
 * `store.keys()` is index-only (cheap) and reflects every attempt durably
 * recorded for this cell INCLUDING ones from a prior session, so the number
 * is correct across process boundaries.
 */
export function nextAttemptNumber(store, family, cellKey) {
  let max = -1;
  for (const key of store.keys()) {
    const parsed = parseAttemptKey(key);
    if (!parsed || parsed.family !== family || parsed.cellKey !== cellKey) continue;
    if (parsed.through > max) max = parsed.through;
  }
  return max + 1;
}

// ── Batch-resume records (issue #103) ─────────────────────────────────
//
// These two functions live HERE for the same import-cycle reason `#108` moved
// `ATTEMPT_FAMILIES` here: `evals/harness/runner.mjs` imports
// `evals/harness/provider.mjs`, so the provider can never import the runner,
// and both sides need to agree on this record's key and body shape. This
// module depends on nothing else in the repo, so both can import it freely.
//
// ── What a resume record is, and what it deliberately is not ──────────────
// It is the durable half of "re-poll the batch you already paid for" (#103).
// A cell that blew the poll ceiling (#92) fails `timeout`, and per #90 its
// spend is preserved on a `generation-attempt` record while the cell itself
// is re-planned `todo`. Before #103 the next invocation re-entered the engine
// from scratch and submitted a BRAND NEW batch -- paying a second time for
// replies the provider had already produced and would happily hand over
// again. This record carries the two things needed to avoid that:
//
//   `replies`     ─ recovered replies keyed by CONTENT-DERIVED custom_id, so
//                   a re-issued request matches its own prior reply. This is
//                   request-level replay, not "reload a saved batch id":
//                   ideate-core's inter-round state is not durable, so
//                   resuming round 2 means re-entering the engine and
//                   re-issuing round 1 -- served from here, for free.
//   `outstanding` ─ batch handles that had not ended when we gave up. Durable
//                   and re-pollable across sessions.
//
// ── `pricingLever` is not decoration ─────────────────────────────────
// `billing_mode` on a cost row is "api"|"subscription" -- the metering
// REGIME. Batch-vs-single is a different axis entirely: a read-time pricing
// LEVER (`lib/price.mjs`'s `priceRow(row, table, { batch })`), and the ledger
// carries no per-row record of it, so `spendToDate()` applies ONE flag to
// every row in the store. That is survivable while a whole invocation is one
// mode. Resume is the first thing that could straddle it: replies produced
// under the batch API, replayed into an invocation running `--no-batch`,
// would be priced at roughly TWICE what they cost -- spend attributed at the
// wrong RATE rather than double-counted, and the totals still look plausible.
// So the lever the replies were produced under is recorded here, and the
// loader refuses to replay across a mismatch (see `readBatchResumeState` in
// evals/harness/runner.mjs). The state is made unreachable rather than
// detected after the fact.
//
// A proper fix -- a per-row lever on `costRow()` so `priceRows` can read it
// per row instead of being told once -- is a `lib/accounting.mjs` schema
// change and is NOT made here; see docs/resuming-batches.md.
//
// ── Money never lives here ───────────────────────────────────────
// See BATCH_RESUME_FAMILY. `costRows` is always `[]`, enforced below rather
// than assumed: recovered tokens are metered at the moment of RECOVERY (not
// at the moment of replay), onto whichever cell or `generation-attempt`
// record that invocation writes. Metering on recovery rather than on replay
// is deliberate -- a reply we pulled down but the engine never asked for is
// still money the provider charged, and metering on serve would silently
// drop it.

/**
 * The batch-resume record for `cellKey` with the highest attempt number, or
 * null if the store holds none.
 *
 * Highest-attempt-wins is how supersession works in an append-only store:
 * nothing is ever rewritten, so a newer record simply shadows the older ones.
 * A `retired` record (written when a cell finally completes) shadows a live
 * one the same way -- it is a tombstone, not a deletion.
 *
 * @param {ResultsStore} store
 * @param {string} cellKey
 * @returns {{attempt: number, key: string, retired: boolean, pricingLever: string,
 *   replies: object, outstanding: Array}|null}
 */
export function readBatchResumeRecord(store, cellKey) {
  let best = null;
  for (const key of store.keys()) {
    const parsed = parseAttemptKey(key);
    if (!parsed || parsed.family !== BATCH_RESUME_FAMILY || parsed.cellKey !== cellKey) continue;
    if (!best || parsed.through > best.through) best = { ...parsed, key };
  }
  if (!best) return null;
  const body = store.get(best.key);
  const r = (body && body.result) || {};
  return {
    attempt: best.through,
    key: best.key,
    retired: !!r.retired,
    pricingLever: r.pricingLever || null,
    replies: r.replies || {},
    outstanding: Array.isArray(r.outstanding) ? r.outstanding : [],
  };
}

/**
 * Append a batch-resume record for `cellKey`, numbered max+1 across every
 * stored shape via `nextAttemptNumber` -- the same discipline the three
 * compacted families use, and for the same reason (a COUNT collides the
 * moment anything folds or is evicted).
 *
 * @param {ResultsStore} store
 * @param {object} o
 *   @param {string}  o.cellKey
 *   @param {string}  [o.cfg]
 *   @param {object}  [o.replies]      customId -> {model, text, stopReason, usage}
 *   @param {Array}   [o.outstanding]  durable batch handles not yet recovered
 *   @param {string}  o.pricingLever   "batch" | "single" -- see the header
 *   @param {boolean} [o.retired]      tombstone: this cell no longer needs replay
 *   @param {string}  [o.detail]
 */
export function writeBatchResumeRecord(store, { cellKey, cfg, replies = {}, outstanding = [], pricingLever, retired = false, detail = "" }) {
  if (!cellKey) throw new Error("writeBatchResumeRecord: cellKey is required");
  if (pricingLever !== "batch" && pricingLever !== "single") {
    throw new Error(
      `writeBatchResumeRecord: pricingLever must be "batch" or "single", got ${pricingLever} -- a replay record whose ` +
        "pricing lever is unknown cannot be safely replayed into a later invocation (see this module's #103 header)",
    );
  }
  const attempt = nextAttemptNumber(store, BATCH_RESUME_FAMILY, cellKey);
  const key = `${BATCH_RESUME_FAMILY}|cell=${cellKey}|attempt=${attempt}`;
  const models = new Set();
  for (const reply of Object.values(replies)) if (reply && reply.model) models.add(reply.model);
  return store.put({
    key,
    // Sentinel armId, exactly like the other side-ledger records: invisible to
    // planRun() (whose key regex requires a leading `arm=`) and to the prune's
    // cell selection (parseCellKey returns null for this key shape).
    armId: "__batch-replay__",
    briefId: cellKey,
    replicate: 0,
    cfg,
    result: {
      kind: "batch-replay",
      cellKey,
      attempt,
      retired,
      pricingLever,
      replies,
      outstanding,
      detail,
    },
    resolvedModels: { models: [...models] },
    accounting: { state: "skipped", kind: "batch-replay", detail },
    // Enforced, not assumed -- the empty-cost-rows invariant is what lets a
    // superseded replay record be dropped with no salvage step.
    costRows: [],
  });
}

/** Convenience for tests and one-off scripts: a fresh ResultsStore backed by
 *  a new temp directory under the OS tmpdir, so callers never need to know
 *  node:os/node:fs plumbing just to get an isolated store. NOT used by any
 *  production code path — production always passes an explicit `results/`-
 *  derived dir so it's obvious at the call site where data lands. */
export function makeTempStore(prefix = "ideate-store-") {
  const dir = join(tmpdir(), `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return new ResultsStore(dir);
}
