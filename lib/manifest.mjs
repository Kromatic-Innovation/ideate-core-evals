// manifest.mjs — cell identity and additive run planning.
//
// The study is ADDITIVE: a run contributes cells to a durable store rather than
// replacing it, so replicate count grows across sessions instead of being
// re-collected. That only works if "have I already run this?" has an exact
// answer, which is what a cell key is.
//
// ── What a cell is ──────────────────────────────────────────────────────────
// One cell = one (arm, brief, replicate) observation. Its RESULT is only
// comparable to another cell's if everything that could change the measurement
// is also identical — the engine SHA, the prompt text, the model IDs, the panel
// shape, the judge. Those are folded into a `configHash`, and the hash is part
// of the key.
//
// This is the load-bearing bit: bump the harness or edit a brief, and cells
// computed under the old config get a DIFFERENT key. They are not silently
// reused, and they are not silently discarded either — they remain in the store
// under their own config, and `planRun` reports them as `stale` so the analysis
// can decide whether to pool them. Nothing is ever quietly mixed.

import { createHash } from "node:crypto";

/** Fields that, if changed, make prior results incomparable. Order-independent:
 *  the object is canonicalized before hashing so key order can't change the hash. */
export const CONFIG_FIELDS = [
  "harnessVersion",
  "engineSha",
  "promptHash",
  "judgeHash",
  "embedderId",
  // armsConfigHash (arms.config.json, issue #101): the ARM CONFIGURATION —
  // panel shape and, above all, every arm's model assignment. This replaces
  // the `ideasPerAgent` / `maxRounds` entries that used to sit here.
  //
  // Those two were removed rather than populated. They had never been set by
  // any caller, and they could not honestly BE set: `spec.config` is
  // per-spec, while both values are per-ARM (arms.config.json's panel block
  // says `ideasPerAgent: 6` / `maxRounds: 2`, but arm A overrides with a
  // single solo call and `maxRounds: 1`). Stamping the panel constant into a
  // per-spec slot would have made the hash claim coverage of a value it did
  // not actually pin — worse than the absence, because a declared field reads
  // as covered. `armsConfigHash` covers both, per-arm, exactly as they are
  // written, and covers the model assignments the panel constants never
  // could.
  //
  // The headline defect this closes (issue #101): arms.config.json was hashed
  // NOWHERE. Its own header states the study's design intent — "the ONLY
  // thing varying between arms is model assignment" — so the single variable
  // this study manipulates was invisible to the mechanism that decides which
  // cells are comparable. Editing arm C from claude-sonnet-5 to
  // claude-opus-5 produced cells with an IDENTICAL configHash, which
  // `planRun` classifies `reuse`: two different experiments pooled silently,
  // with no `stale` warning. See `armsConfigHash()` below.
  "armsConfigHash",
  // corpusHash (evals/corpus/index.mjs, issue #2): the frozen 12-brief corpus
  // is comparability-relevant for the same reason promptHash/judgeHash are —
  // editing or adding a brief changes what was measured. This is an ADDITIVE
  // change: configHash already skips any field that's `undefined` (see the
  // loop below), so every config object that predates this corpus module and
  // never sets `corpusHash` hashes exactly as it did before. Only configs
  // that opt in by supplying `corpusHash` are affected. See
  // manifest.test.mjs "corpusHash participates in configHash once supplied".
  "corpusHash",
  // clusterDistanceThreshold (evals/metrics/voyage-calibration.mjs, issue
  // #42): distinct_k is a direct function of the clustering distance
  // threshold, so a threshold change is exactly as comparability-relevant as
  // a prompt or judge change — cells computed under one threshold must not
  // be silently pooled with cells computed under another. Additive per the
  // same reasoning as corpusHash above: configHash already skips `undefined`
  // fields, so any config object that never sets this hashes exactly as it
  // did before this field was added.
  "clusterDistanceThreshold",
];

/** Keys in arms.config.json that are DOCUMENTATION, not measurement.
 *
 *  `label` and `purpose` are prose the runner never reads (it reads `mode`,
 *  `personaDisabled`, `totalIdeasRequested` and `slots`), as is any
 *  `_`-prefixed key (`_comment`, `_modelIdSource`). Editing them changes what
 *  a reader is TOLD about an arm, never what was measured of it, so hashing
 *  them would falsely mark every stored cell `stale` on a typo fix.
 *
 *  This is the same distinction docs/PREREGISTRATION.md Appendix B item 15
 *  draws when it keeps `analysisHash` out of `configHash`: a change to how
 *  numbers are described or computed is not a change to what was measured.
 *
 *  Deliberately a DENYLIST of named prose fields, not an allowlist of
 *  measurement fields. The two err in opposite directions and only one is
 *  safe here: an allowlist would silently omit any measurement-relevant field
 *  added to arms.config.json later — the exact under-coverage failure issue
 *  #101 exists to end. A denylist errs toward over-invalidation instead: a
 *  new field is hashed by default, and the cost of being wrong is a loud,
 *  conservative `stale` rather than a silent pool. */
const ARMS_CONFIG_DOC_ONLY_KEYS = new Set(["label", "purpose"]);

/** Recursively drop documentation keys and sort object keys, so the result
 *  serializes identically regardless of the literal key order in the file.
 *  ARRAY order is preserved on purpose: a panel's `slots` array is an ordered
 *  persona→model assignment, and reordering it is a real config change. */
function canonicalizeArmsConfig(value) {
  if (Array.isArray(value)) return value.map(canonicalizeArmsConfig);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (k.startsWith("_") || ARMS_CONFIG_DOC_ONLY_KEYS.has(k)) continue;
      out[k] = canonicalizeArmsConfig(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * Hash the ARM CONFIGURATION — arms.config.json's parsed content (issue #101).
 *
 * The value `evals/run.mjs` stamps as `config.armsConfigHash`. It covers every
 * arm's model assignment, its mode/persona settings, its slot ORDER, and the
 * panel block's shape (`size` / `ideasPerAgent` / `maxRounds`), each per-arm
 * exactly as written — which is what makes it an honest replacement for the
 * per-spec `ideasPerAgent` / `maxRounds` fields it retires (see CONFIG_FIELDS).
 *
 * sha256, first 12 hex chars — the same convention as `configHash`,
 * `corpusHash` and `judgePromptHash`.
 *
 * @param {object} armsConfig  the PARSED arms.config.json object
 * @returns {string} 12 hex chars
 */
export function armsConfigHash(armsConfig) {
  if (!armsConfig || typeof armsConfig !== "object" || Array.isArray(armsConfig)) {
    throw new Error("armsConfigHash: the parsed arms.config.json object is required");
  }
  return createHash("sha256").update(JSON.stringify(canonicalizeArmsConfig(armsConfig))).digest("hex").slice(0, 12);
}

/**
 * Deterministic hash of the comparability-relevant config. Sorted keys so two
 * structurally-equal configs always hash identically regardless of literal order.
 */
export function configHash(config = {}) {
  const picked = {};
  for (const f of CONFIG_FIELDS.slice().sort()) {
    if (config[f] !== undefined) picked[f] = config[f];
  }
  return createHash("sha256").update(JSON.stringify(picked)).digest("hex").slice(0, 12);
}

/**
 * Stable, human-readable cell key. Readable on purpose — these end up in logs,
 * filenames, and error messages, and an opaque hash there costs debugging time.
 */
export function cellKey({ armId, briefId, replicate, cfg }) {
  if (!armId || !briefId) throw new Error("cellKey: armId and briefId are required");
  if (!Number.isInteger(replicate) || replicate < 0) {
    throw new Error(`cellKey: replicate must be a non-negative integer, got ${replicate}`);
  }
  if (!cfg) throw new Error("cellKey: cfg (configHash) is required — an unversioned cell key would silently pool incomparable results");
  return `arm=${armId}|brief=${briefId}|rep=${replicate}|cfg=${cfg}`;
}

/**
 * Enumerate every cell a spec calls for.
 * @param {object} spec { arms: [{id}], briefs: [{id}], replicates: number, config: object }
 */
export function planCells(spec) {
  const arms = Array.isArray(spec.arms) ? spec.arms : [];
  const briefs = Array.isArray(spec.briefs) ? spec.briefs : [];
  const replicates = Number.isInteger(spec.replicates) && spec.replicates > 0 ? spec.replicates : 1;
  const cfg = configHash(spec.config || {});

  const cells = [];
  for (const arm of arms) {
    for (const brief of briefs) {
      for (let r = 0; r < replicates; r++) {
        cells.push({
          key: cellKey({ armId: arm.id, briefId: brief.id, replicate: r, cfg }),
          armId: arm.id,
          briefId: brief.id,
          replicate: r,
          cfg,
        });
      }
    }
  }
  return cells;
}

/**
 * Diff the plan against what the store already holds — the additive core.
 *
 * Returns { todo, reuse, stale }:
 *   - todo:  planned cells with no stored result under this config. These run.
 *   - reuse: planned cells already present under this EXACT config. Free.
 *   - stale: stored cells matching (arm, brief, replicate) but under a DIFFERENT
 *            config hash. Never reused automatically; surfaced so the analysis
 *            can decide. Silently reusing these is the failure mode this whole
 *            module exists to prevent.
 */
export function planRun(spec, storedKeys = []) {
  const stored = new Set(storedKeys);
  const storedByTriple = new Map();
  for (const k of stored) {
    const m = /^arm=(.+)\|brief=(.+)\|rep=(\d+)\|cfg=(.+)$/.exec(k);
    if (!m) continue;
    const triple = `${m[1]}|${m[2]}|${m[3]}`;
    if (!storedByTriple.has(triple)) storedByTriple.set(triple, []);
    storedByTriple.get(triple).push({ key: k, cfg: m[4] });
  }

  const todo = [];
  const reuse = [];
  const stale = [];
  for (const cell of planCells(spec)) {
    if (stored.has(cell.key)) {
      reuse.push(cell);
      continue;
    }
    todo.push(cell);
    const triple = `${cell.armId}|${cell.briefId}|${cell.replicate}`;
    for (const prior of storedByTriple.get(triple) || []) {
      if (prior.cfg !== cell.cfg) stale.push({ ...cell, priorKey: prior.key, priorCfg: prior.cfg });
    }
  }
  return { todo, reuse, stale };
}
