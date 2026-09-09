// stage1c.test.mjs -- Appendix M item 5's per-arm configHash rule.
//
// The rule exists to keep 5 specific cells OUT of the treatment arm. Stage 1c's
// first run lost 139 of 144 S1C-RICH cells to a max-effort truncation defect
// (#168); the 5 that survived are exactly the cells in which none of the four
// max-effort replies truncated. They are the most outcome-selected subset in
// the store, and pooling the pre- and post-#168 hashes wholesale would fold
// them into the corrected arm.
//
// Hermetic -- no store, no network. Both functions under test are pure over a
// frame/tally shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRE_168_CONFIG_HASH,
  resolveS1cArmHashes,
  applyArmHashRule,
  S1C_REFERENCE_ARM,
  S1C_PANEL_ARM,
  S1C_CONTROL_ARM,
} from "./stage1c.mjs";

/** A synthetic stand-in for the post-#168 configHash, NOT the real one. These
 *  tests must not pin what the corrected run happens to write -- the rule under
 *  test is "the treatment arm comes from whichever hash is not the pre-#168
 *  one", and hard-coding the real value would test the fixture instead. (For
 *  the record, the run wrote 9b17e4ba0734.) */
const POST = "post168hash0";

/** A tally in the shape tallyStoredConfigs returns. */
const tallyOf = (...cfgs) => cfgs.map((cfg) => ({ cfg, count: 1, states: ["completed"] }));

/** A frame carrying the real Stage 1c contamination: controls under the OLD
 *  hash, corrected RICH under the NEW one, and the outcome-selected RICH
 *  survivors under the OLD one. */
function contaminatedFrame() {
  const rows = [];
  for (let i = 0; i < 3; i++) rows.push({ armId: S1C_REFERENCE_ARM, briefId: `b${i}`, cfg: PRE_168_CONFIG_HASH, response: 44 });
  for (let i = 0; i < 3; i++) rows.push({ armId: S1C_CONTROL_ARM, briefId: `b${i}`, cfg: PRE_168_CONFIG_HASH, response: 40 });
  for (let i = 0; i < 4; i++) rows.push({ armId: S1C_PANEL_ARM, briefId: `b${i}`, cfg: POST, response: 47 });
  // The survivors. Given a DIFFERENT response so a test can prove they are gone
  // by their effect on the mean, not merely by a row count.
  for (let i = 0; i < 2; i++) rows.push({ armId: S1C_PANEL_ARM, briefId: `s${i}`, cfg: PRE_168_CONFIG_HASH, response: 99 });
  return {
    rows,
    armLevels: [S1C_REFERENCE_ARM, S1C_CONTROL_ARM, S1C_PANEL_ARM],
    excluded: { failed: [], skipped: [], stale: [] },
  };
}

// ── resolveS1cArmHashes ─────────────────────────────────────────────────────

test("Appendix M item 5: controls resolve to the pre-#168 hash and S1C-RICH to the post-#168 one", () => {
  const { armHashes, post } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  assert.equal(post, POST);
  assert.equal(armHashes[S1C_REFERENCE_ARM], PRE_168_CONFIG_HASH);
  assert.equal(armHashes[S1C_CONTROL_ARM], PRE_168_CONFIG_HASH);
  assert.equal(armHashes[S1C_PANEL_ARM], POST);
  // The property the whole rule rests on: the treatment arm is NOT read from
  // the hash its contaminated survivors are stored under.
  assert.notEqual(armHashes[S1C_PANEL_ARM], PRE_168_CONFIG_HASH);
});

test("Appendix M item 5: a store with only the pre-#168 hash returns null -- the re-collect has not run", () => {
  assert.equal(resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH)), null);
});

test("Appendix M item 5: a store missing the pre-#168 hash is refused, not guessed at", () => {
  assert.throws(() => resolveS1cArmHashes(tallyOf(POST)), /does not hold the pre-#168 configHash/);
});

test("Appendix M item 5: THREE hashes are refused -- this tool will not choose which is S1C-RICH's", () => {
  assert.throws(
    () => resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST, "cccccccccccc")),
    /will not choose between them/,
  );
});

// ── applyArmHashRule ────────────────────────────────────────────────────────

test("Appendix M item 5: the outcome-selected old-hash S1C-RICH rows are dropped from the treatment arm", () => {
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  const frame = applyArmHashRule(contaminatedFrame(), armHashes);

  const rich = frame.rows.filter((r) => r.armId === S1C_PANEL_ARM);
  assert.equal(rich.length, 4, "only the post-#168 RICH rows survive");
  assert.ok(rich.every((r) => r.cfg === POST));
  // The stronger assertion: the survivors' distinctive response is gone, so
  // this cannot pass by dropping the wrong rows and keeping the count right.
  assert.ok(!rich.some((r) => r.response === 99), "no outcome-selected survivor may reach the treatment arm");
  assert.equal(frame.droppedByArmHashRule.filter((r) => r.armId === S1C_PANEL_ARM).length, 2);
});

test("Appendix M item 5: both control arms are REUSED in full -- the point of the rule is to keep them", () => {
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  const frame = applyArmHashRule(contaminatedFrame(), armHashes);
  for (const arm of [S1C_REFERENCE_ARM, S1C_CONTROL_ARM]) {
    const rows = frame.rows.filter((r) => r.armId === arm);
    assert.equal(rows.length, 3, `${arm} keeps every pre-#168 row`);
    assert.ok(rows.every((r) => r.cfg === PRE_168_CONFIG_HASH));
  }
  assert.equal(frame.droppedByArmHashRule.filter((r) => r.armId !== S1C_PANEL_ARM).length, 0);
});

test("Appendix M item 5: the input frame is not mutated", () => {
  const original = contaminatedFrame();
  const before = original.rows.length;
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  applyArmHashRule(original, armHashes);
  assert.equal(original.rows.length, before);
});

test("Appendix M item 5: an arm left with no rows drops out of armLevels rather than lingering empty", () => {
  // The state a store in mid-re-collect is in: RICH's new-hash cells have not
  // landed yet, so every RICH row is an old-hash survivor and all are dropped.
  const frame = contaminatedFrame();
  frame.rows = frame.rows.filter((r) => r.cfg === PRE_168_CONFIG_HASH);
  const out = applyArmHashRule(frame, {
    [S1C_REFERENCE_ARM]: PRE_168_CONFIG_HASH,
    [S1C_CONTROL_ARM]: PRE_168_CONFIG_HASH,
    [S1C_PANEL_ARM]: POST,
  });
  assert.ok(!out.armLevels.includes(S1C_PANEL_ARM), "an empty arm must not linger as a level");
  assert.deepEqual(out.armLevels, [S1C_REFERENCE_ARM, S1C_CONTROL_ARM]);
});

test("Appendix M item 5: an arm with no assigned hash is passed through untouched", () => {
  // Defensive: the rule names three arms, and a store holding a fourth (a
  // future arm, or a sentinel that slipped the cell-key filter) must not be
  // silently deleted by a rule that says nothing about it.
  const frame = contaminatedFrame();
  frame.rows.push({ armId: "S1C-FUTURE", briefId: "b0", cfg: "ffffffffffff", response: 1 });
  frame.armLevels.push("S1C-FUTURE");
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  const out = applyArmHashRule(frame, armHashes);
  assert.equal(out.rows.filter((r) => r.armId === "S1C-FUTURE").length, 1);
});
