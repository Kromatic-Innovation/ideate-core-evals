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
  "ideasPerAgent",
  "maxRounds",
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
