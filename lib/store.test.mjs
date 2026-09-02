// Tests for the append-only results store (#6): the persistence that
// `planRun(spec, store.keys())` diffs against. Hermetic — every test gets its
// own temp directory (node:os tmpdir + node:fs), never touches the real
// results/ (which is gitignored and per-deployment), and cleans up after
// itself even on failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResultsStore } from "./store.mjs";
import { cellKey, configHash, planCells, planRun } from "./manifest.mjs";

/** Fresh temp dir per test, auto-cleaned via t.after — no test leaks state
 *  into another, and no test leaves files behind on either pass or throw. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-store-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CFG = configHash({ harnessVersion: "0.0.1", engineSha: "920c086", promptHash: "p1" });

function makeRecord({ armId, briefId, replicate, cfg = CFG, resultTag = "ok" }) {
  const key = cellKey({ armId, briefId, replicate, cfg });
  return {
    key,
    armId,
    briefId,
    replicate,
    cfg,
    result: { candidates: [`idea-${resultTag}`], distinct_k: 3 },
    resolvedModels: { proposer: "claude-haiku-4-5", judge: "claude-opus-5" },
    accounting: { state: "completed" },
    costRows: [
      {
        cellKey: key,
        timestamp: "2026-07-30T12:00:00Z",
        billing_mode: "api",
        model: "claude-haiku-4-5",
        input_tokens: 1200,
        output_tokens: 800,
      },
    ],
  };
}

// ── Basic put/get/keys/has round-trip ───────────────────────────────────────

test("put then get round-trips the full record", (t) => {
  const store = new ResultsStore(tempDir(t));
  const record = makeRecord({ armId: "B", briefId: "b1", replicate: 0 });
  const outcome = store.put(record);
  assert.equal(outcome.written, true);

  const fetched = store.get(record.key);
  assert.deepEqual(fetched.result, record.result);
  assert.deepEqual(fetched.resolvedModels, record.resolvedModels);
  assert.deepEqual(fetched.accounting, record.accounting);
  assert.deepEqual(fetched.costRows, record.costRows);
});

test("keys() and has() reflect stored records", (t) => {
  const store = new ResultsStore(tempDir(t));
  const r1 = makeRecord({ armId: "B", briefId: "b1", replicate: 0 });
  const r2 = makeRecord({ armId: "B", briefId: "b2", replicate: 0 });
  store.put(r1);
  store.put(r2);
  assert.deepEqual(new Set(store.keys()), new Set([r1.key, r2.key]));
  assert.ok(store.has(r1.key));
  assert.ok(!store.has("arm=Z|brief=zz|rep=0|cfg=zzz"));
});

test("get() throws for an unknown key", (t) => {
  const store = new ResultsStore(tempDir(t));
  assert.throws(() => store.get("arm=Z|brief=zz|rep=0|cfg=zzz"), /no stored record/);
});

test("put() validates the record shape", (t) => {
  const store = new ResultsStore(tempDir(t));
  const base = makeRecord({ armId: "B", briefId: "b1", replicate: 0 });
  assert.throws(() => store.put({ ...base, key: undefined }), /record\.key is required/);
  assert.throws(() => store.put({ ...base, result: undefined }), /record\.result is required/);
  assert.throws(() => store.put({ ...base, resolvedModels: undefined }), /resolvedModels is required/);
  assert.throws(() => store.put({ ...base, accounting: undefined }), /record\.accounting/);
  assert.throws(() => store.put({ ...base, accounting: {} }), /record\.accounting/);
  assert.throws(() => store.put({ ...base, costRows: undefined }), /costRows must be an array/);
});

test("put() refuses a cost row carrying a dollar figure, even bypassing costRow()", (t) => {
  const store = new ResultsStore(tempDir(t));
  const base = makeRecord({ armId: "B", briefId: "b1", replicate: 0 });
  base.costRows = [{ ...base.costRows[0], cost_usd: 0.42 }];
  assert.throws(() => store.put(base), /never carry a dollar figure/);
});

// ── The append-only / no-mutation invariant ─────────────────────────────────

test("re-putting the exact same record is a verified no-op, not an error", (t) => {
  const store = new ResultsStore(tempDir(t));
  const record = makeRecord({ armId: "B", briefId: "b1", replicate: 0 });
  const first = store.put(record);
  const second = store.put(structuredClone(record)); // fresh object, same content
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.equal(second.reason, "byte-identical no-op");
  assert.equal(store.keys().length, 1, "no duplicate index entry was created");
});

test("re-putting the same key with DIFFERENT content throws — prior cells stay byte-identical", (t) => {
  const store = new ResultsStore(tempDir(t));
  const record = makeRecord({ armId: "B", briefId: "b1", replicate: 0 });
  store.put(record);
  const beforeBody = store.get(record.key);

  const mutated = { ...structuredClone(record), result: { candidates: ["a completely different idea"] } };
  assert.throws(() => store.put(mutated), /append-only/);

  const afterBody = store.get(record.key);
  assert.deepEqual(afterBody, beforeBody, "the stored record is untouched by the rejected mutation attempt");
});

test("record field order does not defeat the byte-identical comparison", (t) => {
  const store = new ResultsStore(tempDir(t));
  const record = makeRecord({ armId: "B", briefId: "b1", replicate: 0 });
  store.put(record);
  // Same content, different key insertion order + nested object key order.
  const reordered = {
    costRows: record.costRows,
    accounting: record.accounting,
    resolvedModels: { judge: record.resolvedModels.judge, proposer: record.resolvedModels.proposer },
    result: record.result,
    key: record.key,
    armId: record.armId,
    briefId: record.briefId,
    replicate: record.replicate,
    cfg: record.cfg,
  };
  const outcome = store.put(reordered);
  assert.equal(outcome.written, false, "structurally-identical records must not be treated as a mutation");
});

// ── AC1: a second run of an identical spec performs zero API calls ─────────

test("AC1 — second run of an identical spec: planRun reports all reuse, nothing todo", (t) => {
  const store = new ResultsStore(tempDir(t));
  const spec = {
    arms: [{ id: "B" }, { id: "D" }],
    briefs: [{ id: "b1" }, { id: "b2" }],
    replicates: 2,
    config: { harnessVersion: "0.0.1", engineSha: "920c086", promptHash: "p1" },
  };
  for (const cell of planCells(spec)) {
    store.put(makeRecord({ armId: cell.armId, briefId: cell.briefId, replicate: cell.replicate, cfg: cell.cfg }));
  }

  const plan = planRun(spec, store.keys());
  assert.equal(plan.todo.length, 0, "an identical second run needs zero API calls");
  assert.equal(plan.reuse.length, planCells(spec).length);
  assert.equal(plan.stale.length, 0);
});

// ── AC2: raising replicates adds only new cells; prior cells stay byte-identical ──

test("AC2 — raising replicates adds only new cells and leaves prior records byte-identical", (t) => {
  const store = new ResultsStore(tempDir(t));
  const spec = {
    arms: [{ id: "B" }, { id: "D" }],
    briefs: [{ id: "b1" }, { id: "b2" }],
    replicates: 2,
    config: { harnessVersion: "0.0.1", engineSha: "920c086", promptHash: "p1" },
  };
  const initialCells = planCells(spec);
  for (const cell of initialCells) {
    store.put(makeRecord({ armId: cell.armId, briefId: cell.briefId, replicate: cell.replicate, cfg: cell.cfg }));
  }
  const priorBodies = new Map(initialCells.map((c) => [c.key, store.get(c.key)]));

  const wider = { ...spec, replicates: 4 };
  const plan = planRun(wider, store.keys());
  assert.equal(plan.reuse.length, initialCells.length, "the original cells still count as reuse");
  assert.equal(plan.todo.length, 8, "only the 8 new replicates (2 arms x 2 briefs x 2 new reps) are todo");
  assert.ok(plan.todo.every((c) => c.replicate >= 2));

  // "Store" the new cells too, then verify EVERY prior record is untouched.
  for (const cell of plan.todo) {
    store.put(makeRecord({ armId: cell.armId, briefId: cell.briefId, replicate: cell.replicate, cfg: cell.cfg }));
  }
  for (const [key, body] of priorBodies) {
    assert.deepEqual(store.get(key), body, `prior cell ${key} must be byte-identical after extending replicates`);
  }
  assert.equal(store.keys().length, initialCells.length + plan.todo.length);
});

// ── AC3: a config bump leaves prior cells intact and retrievable, surfaced as stale ──

test("AC3 — a config bump leaves prior cells intact + retrievable; planRun surfaces them as stale", (t) => {
  const store = new ResultsStore(tempDir(t));
  const spec = {
    arms: [{ id: "B" }],
    briefs: [{ id: "b1" }, { id: "b2" }],
    replicates: 1,
    config: { harnessVersion: "0.0.1", engineSha: "920c086", promptHash: "p1" },
  };
  const oldCells = planCells(spec);
  for (const cell of oldCells) {
    store.put(makeRecord({ armId: cell.armId, briefId: cell.briefId, replicate: cell.replicate, cfg: cell.cfg }));
  }

  const bumped = { ...spec, config: { ...spec.config, engineSha: "deadbee" } };
  const plan = planRun(bumped, store.keys());
  assert.equal(plan.reuse.length, 0, "a different engine SHA is never auto-reused");
  assert.equal(plan.todo.length, oldCells.length);
  assert.equal(plan.stale.length, oldCells.length, "prior cells are surfaced as stale, not silently discarded");

  // The load-bearing part: the OLD keys are still present in the store and
  // readable under their old config hash — nothing was deleted or migrated.
  for (const cell of oldCells) {
    assert.ok(store.has(cell.key), `old cell ${cell.key} must still be present after a config bump`);
    const body = store.get(cell.key);
    assert.equal(body.key, cell.key);
  }
  for (const staleCell of plan.stale) {
    assert.ok(store.has(staleCell.priorKey), "planRun's reported stale.priorKey must resolve in the store");
  }
});

// ── AC4: round-trips through planRun correctly at 400+ cells, cheaply ──────

test("AC4 — 400+ cell plan round-trips through planRun correctly, and the index read is cheap (no bodies touched)", (t) => {
  const store = new ResultsStore(tempDir(t));
  const arms = Array.from({ length: 9 }, (_, i) => ({ id: `arm${i}` }));
  const briefs = Array.from({ length: 12 }, (_, i) => ({ id: `brief${i}` }));
  const spec = {
    arms,
    briefs,
    replicates: 4,
    config: { harnessVersion: "0.0.1", engineSha: "920c086", promptHash: "p1" },
  };
  const cells = planCells(spec);
  assert.equal(cells.length, 9 * 12 * 4, "sanity: 432 cells, satisfying the 400+ requirement");

  // Make the payload deliberately non-trivial so a body-reading keys() would
  // be measurably, not just theoretically, more expensive.
  for (const cell of cells) {
    const record = makeRecord({ armId: cell.armId, briefId: cell.briefId, replicate: cell.replicate, cfg: cell.cfg });
    record.result.candidates = Array.from({ length: 50 }, (_, i) => `idea-${cell.key}-${i}-${"x".repeat(200)}`);
    store.put(record);
  }
  assert.equal(store.keys().length, cells.length);

  // Cheapness assertion: keys() must not read anything under bodies/ — proven
  // by comparing the total bytes a keys()-style load touches (index.jsonl
  // alone) against the total bytes all the (deliberately inflated) bodies
  // occupy. A body-scanning implementation would have to read the latter;
  // an index-only one only ever reads the former, and the gap here is ~40x.
  const indexBytes = readFileSync(store.indexPath, "utf8").length;
  const totalBodyBytes = readdirSync(store.bodiesDir)
    .map((f) => readFileSync(join(store.bodiesDir, f), "utf8").length)
    .reduce((a, b) => a + b, 0);
  assert.ok(
    indexBytes < totalBodyBytes / 10,
    `index.jsonl (${indexBytes}B) should be far smaller than the ${cells.length} bodies it indexes (${totalBodyBytes}B total) — ` +
      `keys()/planRun's diff must only ever pay for the index`,
  );

  // A fresh ResultsStore instance (simulating a new process opening the
  // store) must diff correctly: identical spec -> all reuse.
  const reopened = new ResultsStore(store.dir);
  const same = planRun(spec, reopened.keys());
  assert.equal(same.todo.length, 0);
  assert.equal(same.reuse.length, cells.length);
  assert.equal(same.stale.length, 0);

  // Widen replicates on the 432-cell base: only new cells are todo, and every
  // one of the original 432 is still retrievable byte-identical.
  const wider = { ...spec, replicates: 6 };
  const widerPlan = planRun(wider, reopened.keys());
  assert.equal(widerPlan.reuse.length, cells.length);
  assert.equal(widerPlan.todo.length, 9 * 12 * 2, "only the 2 new replicates per arm x brief");
  assert.ok(widerPlan.todo.every((c) => c.replicate >= 4));
});

// ── Directory is configurable, not hardcoded ────────────────────────────────

test("store requires an explicit dir and never assumes results/", () => {
  assert.throws(() => new ResultsStore(), /dir is required/);
  assert.throws(() => new ResultsStore(""), /dir is required/);
});

test("store creates its directory structure (index + bodies/) on construction", (t) => {
  const dir = tempDir(t);
  const nested = join(dir, "nested", "store-dir");
  const store = new ResultsStore(nested);
  assert.equal(store.dir, nested);
  const entry = store.put(makeRecord({ armId: "B", briefId: "b1", replicate: 0 }));
  assert.equal(entry.written, true);
});

test("a second ResultsStore instance opened on the same dir sees prior puts", (t) => {
  const dir = tempDir(t);
  const first = new ResultsStore(dir);
  const record = makeRecord({ armId: "B", briefId: "b1", replicate: 0 });
  first.put(record);

  const second = new ResultsStore(dir);
  assert.ok(second.has(record.key));
  assert.deepEqual(second.get(record.key).result, record.result);
});

// ── remove(): the one removal path (issue #98) ──────────────────────────────
// The store was append-only AND removal-free until #98. `put()` is unchanged
// and still refuses to rewrite a key; these cover the new, narrow escape
// hatch and every guard on it. See lib/store.mjs's "ONE removal path" header.

function failedRecord({ armId, briefId, replicate, cfg = CFG, kind = "rate_limited" }) {
  const r = makeRecord({ armId, briefId, replicate, cfg });
  r.accounting = { state: "failed", kind, detail: "429 after retries" };
  return r;
}

test("remove() takes a record out of keys/has/get and leaves every other record alone", (t) => {
  const store = new ResultsStore(tempDir(t));
  const doomed = failedRecord({ armId: "A", briefId: "b1", replicate: 0 });
  const survivor = failedRecord({ armId: "A", briefId: "b2", replicate: 0 });
  store.put(doomed);
  store.put(survivor);

  const outcome = store.remove([doomed.key]);
  assert.deepEqual(outcome.removed, [doomed.key]);
  assert.equal(outcome.bodiesUnlinked, 1);

  assert.equal(store.has(doomed.key), false);
  assert.deepEqual(store.keys(), [survivor.key]);
  assert.throws(() => store.get(doomed.key), /no stored record/);
  assert.deepEqual(store.get(survivor.key).result, survivor.result);
});

test("remove() unlinks the body file, not just the index line", (t) => {
  const dir = tempDir(t);
  const store = new ResultsStore(dir);
  const record = failedRecord({ armId: "A", briefId: "b1", replicate: 0 });
  store.put(record);
  assert.equal(readdirSync(join(dir, "bodies")).length, 1);

  store.remove([record.key]);
  assert.deepEqual(readdirSync(join(dir, "bodies")), []);
  // And the index is genuinely rewritten on disk, not merely cache-evicted:
  // a fresh instance must agree.
  assert.deepEqual(new ResultsStore(dir).keys(), []);
});

test("remove() REFUSES a completed cell without an explicit override", (t) => {
  const store = new ResultsStore(tempDir(t));
  const completed = makeRecord({ armId: "A", briefId: "b1", replicate: 0 }); // state: completed
  store.put(completed);

  assert.throws(() => store.remove([completed.key]), /stored as 'completed'.*allowCompleted/s);
  assert.ok(store.has(completed.key), "the refusal must not have removed it anyway");

  store.remove([completed.key], { allowCompleted: true });
  assert.equal(store.has(completed.key), false);
});

test("remove() throws on a key the index does not hold, and removes NOTHING", (t) => {
  const store = new ResultsStore(tempDir(t));
  const a = failedRecord({ armId: "A", briefId: "b1", replicate: 0 });
  const b = failedRecord({ armId: "A", briefId: "b2", replicate: 0 });
  store.put(a);
  store.put(b);

  // The whole batch is validated before anything is written -- a bad key in
  // the middle must not leave a half-applied removal behind.
  assert.throws(() => store.remove([a.key, "arm=A|brief=nope|rep=0|cfg=" + CFG, b.key]), /not in the index/);
  assert.equal(store.keys().length, 2, "a rejected batch removes nothing at all");
});

test("remove() validates the whole batch before writing: one completed key blocks the rest", (t) => {
  const store = new ResultsStore(tempDir(t));
  const failed = failedRecord({ armId: "A", briefId: "b1", replicate: 0 });
  const completed = makeRecord({ armId: "A", briefId: "b2", replicate: 0 });
  store.put(failed);
  store.put(completed);

  assert.throws(() => store.remove([failed.key, completed.key]), /stored as 'completed'/);
  assert.equal(store.keys().length, 2);
});

test("a removed key can be put again -- removal restores the key to 'never stored'", (t) => {
  const store = new ResultsStore(tempDir(t));
  const first = failedRecord({ armId: "A", briefId: "b1", replicate: 0 });
  store.put(first);
  store.remove([first.key]);

  // Different CONTENT under the same key: this would have thrown before the
  // removal (append-only), and must succeed after it. That is exactly the
  // legacy-repair case -- the cell re-runs and stores its real result.
  const second = makeRecord({ armId: "A", briefId: "b1", replicate: 0, resultTag: "rerun" });
  assert.equal(store.put(second).written, true);
  assert.deepEqual(store.get(second.key).result, second.result);
});

test("remove() preserves the index's file order for surviving records", (t) => {
  const dir = tempDir(t);
  const store = new ResultsStore(dir);
  const records = [0, 1, 2, 3].map((r) => failedRecord({ armId: "A", briefId: "b1", replicate: r }));
  for (const r of records) store.put(r);

  store.remove([records[1].key]);
  const order = readFileSync(join(dir, "index.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l).key);
  assert.deepEqual(order, [records[0].key, records[2].key, records[3].key]);
});

test("remove([]) is a no-op and remove() rejects a non-array", (t) => {
  const store = new ResultsStore(tempDir(t));
  const record = failedRecord({ armId: "A", briefId: "b1", replicate: 0 });
  store.put(record);
  assert.deepEqual(store.remove([]), { removed: [], bodiesUnlinked: 0 });
  assert.equal(store.keys().length, 1);
  assert.throws(() => store.remove(record.key), /must be an array/);
});

test("removing a cell makes planRun classify it `todo` again -- the whole point (issue #98)", (t) => {
  const store = new ResultsStore(tempDir(t));
  const spec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: { harnessVersion: "0.0.1", engineSha: "920c086", promptHash: "p1" } };
  const legacy = failedRecord({ armId: "A", briefId: "b1", replicate: 0 });
  store.put(legacy);
  assert.equal(planRun(spec, store.keys()).reuse.length, 1, "precondition: a stored transient failure is `reuse` forever");

  store.remove([legacy.key]);
  const plan = planRun(spec, store.keys());
  assert.equal(plan.reuse.length, 0);
  assert.equal(plan.todo.length, 1);
  assert.equal(plan.todo[0].key, legacy.key);
});
