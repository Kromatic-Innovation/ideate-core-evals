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
