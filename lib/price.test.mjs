// price.test.mjs — tests for the read-time pricer (issue #7).
//
// Hermetic: no network, no filesystem beyond this repo's own source files,
// no dependency on node_modules (proven by running with node_modules moved
// aside -- see the PR description's hermetic-proof transcript). Every test
// constructs its own rows and rate tables rather than reading the real
// ledger, so the suite is deterministic and fast.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { costRow } from "./accounting.mjs";
import {
  RATE_TABLE,
  BATCH_DISCOUNT_BY_MODEL,
  OPENAI_PRICE_VERIFICATION,
  priceRow,
  priceRows,
  repriceRows,
  runnerPriceGrid,
  providerOf,
  priceRowByProvider,
  priceRowsByProvider,
} from "./price.mjs";

// ── AC: "Every rate entry carries a source URL and a date" ──────────────────
describe("RATE_TABLE — every entry carries a source and a date", () => {
  test("every RATE_TABLE entry has a non-empty `source` and `date`", () => {
    const entries = Object.entries(RATE_TABLE);
    assert.ok(entries.length > 0, "RATE_TABLE must not be empty");
    for (const [model, entry] of entries) {
      assert.equal(typeof entry.source, "string", `${model}.source must be a string`);
      assert.ok(entry.source.length > 0, `${model}.source must be non-empty`);
      assert.equal(typeof entry.date, "string", `${model}.date must be a string`);
      assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `${model}.date must be an ISO date`);
    }
  });

  test("covers every model id that appears in arms.config.json's slots", async () => {
    // Read arms.config.json the same way a caller would -- via import
    // assertion-free dynamic read, since this is a .mjs test and the repo
    // targets Node 20 (import assertions for JSON are not universally
    // stable pre-22) -- read + JSON.parse keeps this test portable.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const armsPath = path.default.join(import.meta.dirname, "..", "arms.config.json");
    const arms = JSON.parse(fs.default.readFileSync(armsPath, "utf8"));

    const modelIdsInUse = new Set();
    for (const arm of Object.values(arms.arms)) {
      for (const slot of arm.slots || []) {
        modelIdsInUse.add(slot.model);
      }
    }

    const missing = [...modelIdsInUse].filter((id) => !(id in RATE_TABLE));
    assert.deepEqual(missing, [], `RATE_TABLE is missing an entry for: ${missing.join(", ")}`);
  });

  test("covers every model id in evals/judge/config.mjs's JUDGE_MODELS (issue #45 SHOULD item)", async () => {
    // JUDGE_MODELS isn't a generation-arm slot, so the arms.config.json
    // coverage test above doesn't see it -- without this, a judge model
    // could silently price at $0 (missingRate) forever.
    const { JUDGE_MODELS } = await import("../evals/judge/config.mjs");
    const modelIdsInUse = [...JUDGE_MODELS.anthropic, ...JUDGE_MODELS.openai];
    const missing = modelIdsInUse.filter((id) => !(id in RATE_TABLE));
    assert.deepEqual(missing, [], `RATE_TABLE is missing an entry for judge model(s): ${missing.join(", ")}`);
  });

  test("covers the Voyage-4-lite embedder even though no arm references it directly", () => {
    // Embeddings aren't a panel-arm model slot, but the pre-registration
    // requires the pricer to cover them (§8.1's Voyage-4-lite row).
    assert.ok("voyage-4-lite" in RATE_TABLE);
    assert.equal(RATE_TABLE["voyage-4-lite"].out, 0, "embeddings have no output-token price");
  });

  test("OpenAI rates are marked verified, with the check recorded in OPENAI_PRICE_VERIFICATION", () => {
    // #22: the arm slots now carry the real OpenAI ids directly, so RATE_TABLE
    // keys ARE the model ids (gpt-5.6-terra / gpt-5.6-sol) -- no placeholder.
    assert.equal(RATE_TABLE["gpt-5.6-terra"].verified, true);
    assert.equal(RATE_TABLE["gpt-5.6-sol"].verified, true);
    assert.match(OPENAI_PRICE_VERIFICATION.resolvedUrl, /^https:\/\/.*openai\.com/);
    assert.match(OPENAI_PRICE_VERIFICATION.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(OPENAI_PRICE_VERIFICATION.batchDiscountFound, 0.5);
    // Every verified OpenAI row's rate must appear, verbatim, in the raw fetch
    // record keyed by the SAME model id -- catches a table/record drift bug
    // where someone hand-edits RATE_TABLE without updating the verification log.
    const found = OPENAI_PRICE_VERIFICATION.modelsFoundUsdPerMTok;
    for (const id of ["gpt-5.6-terra", "gpt-5.6-sol"]) {
      const entry = RATE_TABLE[id];
      assert.deepEqual(found[id], { in: entry.in, out: entry.out }, `${id} rate must match the verification record`);
    }
  });
});

// ── AC: "Re-pricing an existing ledger with a changed table produces
//        different totals WITHOUT re-running anything" ────────────────────
describe("re-pricing with a changed rate table", () => {
  const rows = [
    costRow({
      cellKey: "arm=D|brief=biz-01|rep=0|cfg=abc123",
      timestamp: "2026-07-15T00:00:00Z",
      billing_mode: "api",
      model: "claude-opus-5",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    }),
    costRow({
      cellKey: "arm=G|brief=biz-02|rep=0|cfg=abc123",
      timestamp: "2026-07-15T00:00:00Z",
      billing_mode: "api",
      tokens_by_model: {
        "claude-haiku-4-5": { input_tokens: 500_000, output_tokens: 200_000 },
        "gpt-5.6-terra": { input_tokens: 300_000, output_tokens: 100_000 },
      },
    }),
  ];

  test("same rows, table A vs table B, produce different totals — no re-run", () => {
    const tableA = RATE_TABLE;
    // Table B: an arbitrary, deliberately different rate change (a
    // hypothetical future price cut) touching every model the fixture rows
    // reference, so the diff is unambiguous.
    const tableB = {
      "claude-opus-5": { in: 1.0, out: 1.0, source: "test-table-b", date: "2099-01-01" },
      "claude-haiku-4-5": { in: 1.0, out: 1.0, source: "test-table-b", date: "2099-01-01" },
      "gpt-5.6-terra": { in: 1.0, out: 1.0, source: "test-table-b", date: "2099-01-01" },
    };

    const pricedA = priceRows(rows, tableA);
    const pricedB = repriceRows(rows, tableB);

    assert.notEqual(pricedA.totalUsd, pricedB.totalUsd);
    // The SAME rows object was passed to both -- proof that repricing reads
    // the rows, it doesn't mutate or require regenerating them.
    assert.equal(rows.length, 2);
    assert.equal(rows[0].model, "claude-opus-5");
  });

  test("repriceRows never mutates the input rows (pure function of its args)", () => {
    const before = JSON.stringify(rows);
    repriceRows(rows, { "claude-opus-5": { in: 999, out: 999, source: "x", date: "2020-01-01" } });
    const after = JSON.stringify(rows);
    assert.equal(before, after, "rows must be byte-identical after repricing");
  });

  test("changing only ONE model's rate changes only that model's contribution", () => {
    const base = priceRows(rows, RATE_TABLE).totalUsd;
    const bumped = {
      ...RATE_TABLE,
      "claude-opus-5": { ...RATE_TABLE["claude-opus-5"], in: RATE_TABLE["claude-opus-5"].in * 2 },
    };
    const after = priceRows(rows, bumped).totalUsd;
    assert.ok(after > base, "doubling opus input rate must raise the total");
  });
});

// ── AC: "Batch discount is visible in the breakdown" ─────────────────────────
describe("batch discount visibility", () => {
  const row = costRow({
    cellKey: "arm=D|brief=biz-01|rep=0|cfg=abc123",
    timestamp: "2026-07-15T00:00:00Z",
    billing_mode: "api",
    model: "claude-opus-5",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });

  test("a batch figure shows the base and the discount factor separately, not just the final number", () => {
    const priced = priceRow(row, RATE_TABLE, { batch: true });
    const [entry] = priced.byModel;

    assert.ok("baseUsd" in entry, "baseUsd (pre-discount) must be present");
    assert.ok("batchDiscount" in entry, "batchDiscount (the factor) must be present");
    assert.ok("finalUsd" in entry, "finalUsd (post-discount) must be present");
    assert.equal(entry.batchApplied, true);
    assert.equal(entry.batchDiscount, 0.5, "Anthropic batch discount is -50% per §8.1");
    // finalUsd must actually be baseUsd * (1 - discount), not an
    // independently-computed number that happens to match by coincidence.
    assert.equal(entry.finalUsd, entry.baseUsd * (1 - entry.batchDiscount));
    assert.ok(entry.finalUsd < entry.baseUsd, "batch pricing must be cheaper than base");
  });

  test("non-batch pricing shows batchApplied: false and a zero discount, base === final", () => {
    const priced = priceRow(row, RATE_TABLE, { batch: false });
    const [entry] = priced.byModel;
    assert.equal(entry.batchApplied, false);
    assert.equal(entry.batchDiscount, 0);
    assert.equal(entry.finalUsd, entry.baseUsd);
  });

  test("the discount is NOT baked into RATE_TABLE's base in/out rates", () => {
    // If someone accidentally pre-applied -50% to the table itself, batch
    // and non-batch pricing of the same row would differ by a DIFFERENT
    // factor than the documented 0.5 -- this pins the base rate to the
    // pre-registration's published (non-discounted) $5/$25 for Opus 5.
    assert.equal(RATE_TABLE["claude-opus-5"].in, 5.0);
    assert.equal(RATE_TABLE["claude-opus-5"].out, 25.0);
  });

  test("Voyage's batch discount is -33%, not -50%, and that is visible per-row", () => {
    const voyageRow = costRow({
      cellKey: "arm=embed|brief=biz-01|rep=0|cfg=abc123",
      timestamp: "2026-07-15T00:00:00Z",
      billing_mode: "api",
      model: "voyage-4-lite",
      input_tokens: 1_000_000,
      output_tokens: null,
    });
    const priced = priceRow(voyageRow, RATE_TABLE, { batch: true });
    assert.ok(Math.abs(priced.byModel[0].batchDiscount - 1 / 3) < 1e-9);
  });

  test("BATCH_DISCOUNT_BY_MODEL covers every RATE_TABLE model", () => {
    const missing = Object.keys(RATE_TABLE).filter((m) => !(m in BATCH_DISCOUNT_BY_MODEL));
    assert.deepEqual(missing, []);
  });
});

// ── AC: billing regime is named for any figure ───────────────────────────────
describe("billing_mode naming — api vs subscription", () => {
  test("an api-mode row prices to cost_usd (real spend)", () => {
    const row = costRow({
      cellKey: "arm=D|brief=biz-01|rep=0|cfg=abc123",
      timestamp: "2026-07-15T00:00:00Z",
      billing_mode: "api",
      model: "claude-opus-5",
      input_tokens: 1000,
      output_tokens: 1000,
    });
    const priced = priceRow(row);
    assert.equal(priced.usd_field, "cost_usd");
    assert.equal(priced.billing_mode, "api");
  });

  test("a subscription-mode row prices to notional_usd, never cost_usd", () => {
    const row = costRow({
      cellKey: "arm=D|brief=biz-01|rep=1|cfg=abc123",
      timestamp: "2026-07-15T00:00:00Z",
      billing_mode: "subscription",
      model: "claude-opus-5",
      input_tokens: 1000,
      output_tokens: 1000,
    });
    const priced = priceRow(row);
    assert.equal(priced.usd_field, "notional_usd");
    assert.notEqual(priced.usd_field, "cost_usd");
  });

  test("priceRows sums api and subscription rows into SEPARATE totals", () => {
    const apiRow = costRow({
      cellKey: "k1", timestamp: "2026-07-15T00:00:00Z", billing_mode: "api",
      model: "claude-opus-5", input_tokens: 1_000_000, output_tokens: 0,
    });
    const subRow = costRow({
      cellKey: "k2", timestamp: "2026-07-15T00:00:00Z", billing_mode: "subscription",
      model: "claude-opus-5", input_tokens: 1_000_000, output_tokens: 0,
    });
    const { totalUsd, totalNotionalUsd } = priceRows([apiRow, subRow]);
    assert.equal(totalUsd, 5.0); // $5/MTok in, 1M tokens
    assert.equal(totalNotionalUsd, 5.0);
    // The two totals are tracked separately -- never silently combined into
    // one number that would misrepresent notional spend as real spend.
    assert.notEqual(totalUsd, totalUsd + totalNotionalUsd);
  });

  test("priceRows surfaces a missing rate loudly (hasMissingRate/missingRateModels), never as a silent $0 folded into totalUsd", () => {
    const row = costRow({
      cellKey: "k1", timestamp: "2026-07-15T00:00:00Z", billing_mode: "api",
      model: "no-such-model-in-the-table", input_tokens: 1_000_000, output_tokens: 0,
    });
    const priced = priceRows([row]);
    assert.equal(priced.totalUsd, 0);
    assert.equal(priced.hasMissingRate, true);
    assert.deepEqual(priced.missingRateModels, ["no-such-model-in-the-table"]);
  });

  test("priceRows reports hasMissingRate: false and an empty list when every model in the batch is priced", () => {
    const row = costRow({
      cellKey: "k1", timestamp: "2026-07-15T00:00:00Z", billing_mode: "api",
      model: "claude-opus-5", input_tokens: 1_000_000, output_tokens: 0,
    });
    const priced = priceRows([row]);
    assert.equal(priced.hasMissingRate, false);
    assert.deepEqual(priced.missingRateModels, []);
  });

  test("rejects a row with an invalid billing_mode", () => {
    assert.throws(
      () => priceRow({ cellKey: "k", timestamp: "2026-07-15T00:00:00Z", billing_mode: "bogus", model: "claude-opus-5" }),
      /billing_mode/,
    );
  });
});

// ── tokens_by_model (mixed-tier arms E/F/G) ──────────────────────────────────
describe("tokens_by_model — mixed-tier arms", () => {
  test("prices every model in tokens_by_model and sums them", () => {
    const row = costRow({
      cellKey: "arm=G|brief=biz-01|rep=0|cfg=abc123",
      timestamp: "2026-07-15T00:00:00Z",
      billing_mode: "api",
      tokens_by_model: {
        "claude-haiku-4-5": { input_tokens: 1_000_000, output_tokens: 0 },
        "claude-sonnet-5": { input_tokens: 0, output_tokens: 1_000_000 },
        "claude-opus-5": { input_tokens: 1_000_000, output_tokens: 0 },
        "gpt-5.6-terra": { input_tokens: 1_000_000, output_tokens: 0 },
        "gpt-5.6-sol": { input_tokens: 0, output_tokens: 1_000_000 },
      },
    });
    const priced = priceRow(row);
    assert.equal(priced.byModel.length, 5);
    const byModelId = Object.fromEntries(priced.byModel.map((m) => [m.model, m]));

    // haiku: 1M in @ $1/MTok = $1
    assert.ok(Math.abs(byModelId["claude-haiku-4-5"].finalUsd - 1.0) < 1e-9);
    // sonnet: 1M out — note timestamp is within the intro window
    // (through 2026-08-31), so this uses the $10/MTok intro OUT rate, not $15.
    assert.ok(Math.abs(byModelId["claude-sonnet-5"].finalUsd - 10.0) < 1e-9);
    // opus: 1M in @ $5/MTok = $5
    assert.ok(Math.abs(byModelId["claude-opus-5"].finalUsd - 5.0) < 1e-9);
    // openai mid: 1M in @ $2/MTok = $2
    assert.ok(Math.abs(byModelId["gpt-5.6-terra"].finalUsd - 2.0) < 1e-9);
    // openai large: 1M out @ $30/MTok = $30
    assert.ok(Math.abs(byModelId["gpt-5.6-sol"].finalUsd - 30.0) < 1e-9);

    const expectedTotal = 1.0 + 10.0 + 5.0 + 2.0 + 30.0;
    assert.ok(Math.abs(priced.total - expectedTotal) < 1e-6);
  });

  test("a row with neither model nor tokens_by_model throws (costRow already blocks this, defense in depth)", () => {
    assert.throws(
      () => priceRow({ cellKey: "k", timestamp: "2026-07-15T00:00:00Z", billing_mode: "api" }),
      /neither `model` nor `tokens_by_model`/,
    );
  });
});

// ── single-model rows ─────────────────────────────────────────────────────
describe("single-model rows", () => {
  test("prices input + output tokens at the model's base rate", () => {
    const row = costRow({
      cellKey: "arm=B|brief=biz-01|rep=0|cfg=abc123",
      timestamp: "2026-07-15T00:00:00Z",
      billing_mode: "api",
      model: "claude-haiku-4-5",
      input_tokens: 2_000_000,
      output_tokens: 1_000_000,
    });
    const priced = priceRow(row);
    // haiku: $1/MTok in, $5/MTok out -> 2*1 + 1*5 = $7
    assert.ok(Math.abs(priced.total - 7.0) < 1e-9);
  });

  test("cache_read_input_tokens and cache_creation_input_tokens are priced at the input rate", () => {
    const row = costRow({
      cellKey: "arm=B|brief=biz-01|rep=0|cfg=abc123",
      timestamp: "2026-07-15T00:00:00Z",
      billing_mode: "api",
      model: "claude-haiku-4-5",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 500_000,
      cache_creation_input_tokens: 500_000,
    });
    const priced = priceRow(row);
    // 1M cache tokens total @ $1/MTok in = $1
    assert.ok(Math.abs(priced.total - 1.0) < 1e-9);
  });

  test("null token fields (present but no data) contribute $0, not an error", () => {
    const row = costRow({
      cellKey: "arm=B|brief=biz-01|rep=0|cfg=abc123",
      timestamp: "2026-07-15T00:00:00Z",
      billing_mode: "api",
      model: "claude-haiku-4-5",
      input_tokens: null,
      output_tokens: 1_000_000,
    });
    const priced = priceRow(row);
    assert.ok(Math.abs(priced.total - 5.0) < 1e-9); // just the $5 output charge
  });

  test("a model absent from the rate table is reported as missingRate, priced $0, and does not throw", () => {
    const row = { cellKey: "k", timestamp: "2026-07-15T00:00:00Z", billing_mode: "api", model: "claude-opus-99", input_tokens: 1000, output_tokens: 1000 };
    const priced = priceRow(row);
    assert.equal(priced.total, 0);
    assert.equal(priced.byModel[0].missingRate, true);
  });
});

// ── Sonnet 5 intro-rate window ───────────────────────────────────────────────
describe("Sonnet 5 intro rate window (through 2026-08-31)", () => {
  test("a row timestamped before the cutoff uses the intro rate", () => {
    const row = costRow({
      cellKey: "k", timestamp: "2026-08-01T00:00:00Z", billing_mode: "api",
      model: "claude-sonnet-5", input_tokens: 1_000_000, output_tokens: 1_000_000,
    });
    const priced = priceRow(row);
    assert.ok(Math.abs(priced.total - (2.0 + 10.0)) < 1e-9, "intro rate is $2/$10 per MTok");
  });

  test("a row timestamped after the cutoff uses the standard rate", () => {
    const row = costRow({
      cellKey: "k", timestamp: "2026-09-15T00:00:00Z", billing_mode: "api",
      model: "claude-sonnet-5", input_tokens: 1_000_000, output_tokens: 1_000_000,
    });
    const priced = priceRow(row);
    assert.ok(Math.abs(priced.total - (3.0 + 15.0)) < 1e-9, "standard rate is $3/$15 per MTok");
  });

  test("re-pricing the SAME early row before and after the cutoff moment shows the regime, not wall-clock time", () => {
    // Pricing is a pure function of (row, table) -- it must resolve the
    // intro window from the ROW's timestamp, never from "now". Prove this
    // by pricing the same early-dated row twice, far apart in wall-clock
    // terms, and getting the identical (intro) answer both times.
    const row = costRow({
      cellKey: "k", timestamp: "2026-07-01T00:00:00Z", billing_mode: "api",
      model: "claude-sonnet-5", input_tokens: 1_000_000, output_tokens: 0,
    });
    const first = priceRow(row).total;
    const second = priceRow(row).total;
    assert.equal(first, second);
    assert.ok(Math.abs(first - 2.0) < 1e-9);
  });
});

// ── priceRows / batch predicate ──────────────────────────────────────────────
describe("priceRows batch option", () => {
  const rows = [
    costRow({ cellKey: "k1", timestamp: "2026-07-15T00:00:00Z", billing_mode: "api", model: "claude-opus-5", input_tokens: 1_000_000, output_tokens: 0 }),
    costRow({ cellKey: "k2", timestamp: "2026-07-15T00:00:00Z", billing_mode: "api", model: "claude-opus-5", input_tokens: 1_000_000, output_tokens: 0 }),
  ];

  test("a boolean batch flag applies uniformly to every row", () => {
    const { totalUsd } = priceRows(rows, RATE_TABLE, { batch: true });
    assert.ok(Math.abs(totalUsd - 5.0) < 1e-9); // 2 * $5/MTok * 0.5 batch discount = $5
  });

  test("a per-row predicate lets only SOME rows be discounted", () => {
    const { totalUsd, rows: priced } = priceRows(rows, RATE_TABLE, {
      batch: (row) => row.cellKey === "k1",
    });
    assert.equal(priced[0].byModel[0].batchApplied, true);
    assert.equal(priced[1].byModel[0].batchApplied, false);
    // k1: $5 * 0.5 = $2.5, k2: $5 (no discount) = total $7.5
    assert.ok(Math.abs(totalUsd - 7.5) < 1e-9);
  });
});

// ── runnerPriceGrid adapter ───────────────────────────────────────────────────
describe("runnerPriceGrid — optional DI adapter for evals/harness/runner.mjs", () => {
  const arms = {
    D: { mode: "panel", slots: [{ persona: "p1", model: "claude-opus-5" }, { persona: "p2", model: "claude-opus-5" }] },
    A: { mode: "solo", slots: [{ persona: "solo", model: "claude-sonnet-5" }] },
  };

  test("prices a planned cell using this module's RATE_TABLE, batch-discounted by default", () => {
    const priceGrid = runnerPriceGrid();
    const { usd, breakdown } = priceGrid([{ key: "cell-1", armId: "D" }], arms);
    assert.equal(breakdown.length, 1);
    assert.ok(usd > 0);
  });

  test("throws loudly on an unknown arm (fail loud, not fail cheap)", () => {
    const priceGrid = runnerPriceGrid();
    assert.throws(() => priceGrid([{ key: "cell-1", armId: "Z" }], arms), /unknown arm/);
  });

  test("throws loudly on an arm with no slots", () => {
    const priceGrid = runnerPriceGrid();
    assert.throws(
      () => priceGrid([{ key: "cell-1", armId: "empty" }], { empty: { mode: "panel", slots: [] } }),
      /no model slots/,
    );
  });

  test("throws loudly on a model with no rate entry", () => {
    const priceGrid = runnerPriceGrid();
    const armsWithUnknownModel = { X: { mode: "solo", slots: [{ persona: "solo", model: "made-up-model" }] } };
    assert.throws(() => priceGrid([{ key: "cell-1", armId: "X" }], armsWithUnknownModel), /no rate for model/);
  });

  test("a swapped rate table changes the projection with no other code change", () => {
    const cheapTable = { "claude-opus-5": { in: 0.01, out: 0.01, source: "x", date: "2020-01-01" } };
    const priceGrid = runnerPriceGrid(cheapTable);
    const { usd } = priceGrid([{ key: "cell-1", armId: "D" }], arms);
    const { usd: standardUsd } = runnerPriceGrid()([{ key: "cell-1", armId: "D" }], arms);
    assert.ok(usd < standardUsd);
  });

  // ── issue #51: per-cell byProvider, built slot-by-slot ─────────────────────
  test("a single-provider cell's byProvider carries exactly one provider key, summing to the cell's usd", () => {
    const priceGrid = runnerPriceGrid();
    const { breakdown } = priceGrid([{ key: "cell-1", armId: "D" }], arms);
    assert.deepEqual(Object.keys(breakdown[0].byProvider), ["anthropic"]);
    assert.ok(Math.abs(breakdown[0].byProvider.anthropic - breakdown[0].usd) < 1e-9);
  });

  test("a cross-provider cell (arm G shape) splits byProvider slot-by-slot -- never flat-assigned to one provider", () => {
    const mixedArms = {
      G: {
        mode: "panel",
        slots: [
          { persona: "proposer_1", model: "claude-haiku-4-5" },
          { persona: "proposer_2", model: "claude-sonnet-5" },
          { persona: "proposer_3", model: "claude-opus-5" },
          { persona: "proposer_4", model: "gpt-5.6-terra" },
          { persona: "proposer_5", model: "gpt-5.6-sol" },
        ],
      },
    };
    const priceGrid = runnerPriceGrid();
    const { usd, breakdown } = priceGrid([{ key: "cell-g", armId: "G" }], mixedArms);
    const { anthropic, openai } = breakdown[0].byProvider;
    assert.ok(anthropic > 0, "the 3 Anthropic slots contribute a positive Anthropic share");
    assert.ok(openai > 0, "the 2 OpenAI slots contribute a positive OpenAI share");
    assert.ok(Math.abs(anthropic + openai - usd) < 1e-9, "the two provider shares sum to the cell's total");
  });

  // ── issue #63 (fix round): the judge term is OPT-IN, token-priced, batch-
  // aware, scales with candidate count, and fails loud on a missing rate ──
  test("with no judgeLegsFor supplied, the projection is byte-identical to before the judge term existed", () => {
    const withoutJudge = runnerPriceGrid()([{ key: "cell-1", armId: "D" }], arms);
    const withEmptyOpts = runnerPriceGrid(undefined, {})([{ key: "cell-1", armId: "D" }], arms);
    assert.deepEqual(withoutJudge, withEmptyOpts);
  });

  test("judgeLegsFor adds each returned leg's token-priced cost to EVERY planned cell, split by provider", () => {
    const noJudge = runnerPriceGrid()([{ key: "cell-1", armId: "D" }], arms);
    const legsFor = () => [
      { model: "claude-sonnet-4-6", provider: "anthropic", candidateCount: 30 },
      { model: "gpt-5.6-luna", provider: "openai", candidateCount: 30 },
    ];
    const withJudge = runnerPriceGrid(undefined, { judgeLegsFor: legsFor })([{ key: "cell-1", armId: "D" }], arms);
    assert.ok(withJudge.usd > noJudge.usd, "the pre-flight projection must price the planned judging on top of generation");
    assert.ok(withJudge.breakdown[0].byProvider.openai > 0, "an OpenAI judge leg contributes to the openai bucket even on an all-Anthropic generating arm (D)");
    assert.ok(withJudge.breakdown[0].byProvider.anthropic > noJudge.breakdown[0].byProvider.anthropic, "the Anthropic judge leg adds on top of D's own Anthropic generation cost");
  });

  test("an empty legs array from judgeLegsFor contributes nothing", () => {
    const noJudge = runnerPriceGrid()([{ key: "cell-1", armId: "D" }], arms);
    const withEmptyLegs = runnerPriceGrid(undefined, { judgeLegsFor: () => [] })([{ key: "cell-1", armId: "D" }], arms);
    assert.deepEqual(noJudge, withEmptyLegs);
  });

  // ── BLOCKING 1 (fix round): the judge term must apply the SAME batch
  // discount as generation -- the constant's own comment asserts the $43
  // total is already batched, so batch=false must project MORE, never the
  // same amount.
  test("the judge leg's own delta respects `batch` -- batch=false projects exactly 2x batch=true for a 50%-discount model, same as generation", () => {
    const legsFor = () => [{ model: "claude-sonnet-5", provider: "anthropic", candidateCount: 30 }];
    const priceGrid = runnerPriceGrid(undefined, { judgeLegsFor: legsFor });
    const genBatched = runnerPriceGrid()([{ key: "cell-1", armId: "D" }], arms, { batch: true }).usd;
    const genSingle = runnerPriceGrid()([{ key: "cell-1", armId: "D" }], arms, { batch: false }).usd;
    const batched = priceGrid([{ key: "cell-1", armId: "D" }], arms, { batch: true }).usd;
    const single = priceGrid([{ key: "cell-1", armId: "D" }], arms, { batch: false }).usd;
    const judgeDeltaBatched = batched - genBatched;
    const judgeDeltaSingle = single - genSingle;
    assert.ok(judgeDeltaSingle > judgeDeltaBatched, "the judge leg must be MORE expensive under batch=false");
    assert.ok(Math.abs(judgeDeltaSingle - judgeDeltaBatched * 2) < 1e-9, "batch=false must be exactly 2x batch=true for claude-sonnet-5's 50% discount");
  });

  test("the judge term scales with candidateCount -- doubling the estimated pool size doubles the judge delta", () => {
    const gen = runnerPriceGrid()([{ key: "cell-1", armId: "D" }], arms).usd;
    const with30 = runnerPriceGrid(undefined, { judgeLegsFor: () => [{ model: "claude-sonnet-5", provider: "anthropic", candidateCount: 30 }] })([{ key: "cell-1", armId: "D" }], arms).usd - gen;
    const with60 = runnerPriceGrid(undefined, { judgeLegsFor: () => [{ model: "claude-sonnet-5", provider: "anthropic", candidateCount: 60 }] })([{ key: "cell-1", armId: "D" }], arms).usd - gen;
    assert.ok(Math.abs(with60 - with30 * 2) < 1e-9, "a flat per-leg constant would make this delta identical regardless of candidateCount");
  });

  test("the judge term prices different judge models at different rates -- an Opus judge costs more than a Haiku judge for the same candidateCount", () => {
    const gen = runnerPriceGrid()([{ key: "cell-1", armId: "D" }], arms).usd;
    const withOpus = runnerPriceGrid(undefined, { judgeLegsFor: () => [{ model: "claude-opus-5", provider: "anthropic", candidateCount: 30 }] })([{ key: "cell-1", armId: "D" }], arms).usd - gen;
    const withHaiku = runnerPriceGrid(undefined, { judgeLegsFor: () => [{ model: "claude-haiku-4-5", provider: "anthropic", candidateCount: 30 }] })([{ key: "cell-1", armId: "D" }], arms).usd - gen;
    assert.ok(withOpus > withHaiku, "a flat per-leg estimate would price an Opus and a Haiku judge identically; token x rate must not");
  });

  // ── Structural fail-loud parity with the generation slot loop ─────────────
  test("a judge leg's model absent from RATE_TABLE throws -- the same fail-loud guarantee a generation slot gets, never a silent $0 leg", () => {
    const priceGrid = runnerPriceGrid(undefined, { judgeLegsFor: () => [{ model: "made-up-judge-model", provider: "openai", candidateCount: 30 }] });
    assert.throws(() => priceGrid([{ key: "cell-1", armId: "D" }], arms), /no rate for judge model/);
  });
});

// ── priceRowsByProvider: aggregate per-provider attribution across many rows (issue #63) ──
describe("priceRowsByProvider — sums priceRowByProvider across a whole ledger slice", () => {
  test("sums multiple single-model rows into their respective provider buckets", () => {
    const rows = [
      costRow({ cellKey: "c1", timestamp: "2026-08-01T00:00:00Z", billing_mode: "api", model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 500 }),
      costRow({ cellKey: "c2", timestamp: "2026-08-01T00:00:00Z", billing_mode: "api", model: "gpt-5.6-terra", input_tokens: 1000, output_tokens: 500 }),
    ];
    const { byProvider, hasMissingRate, missingRateModels } = priceRowsByProvider(rows);
    assert.ok(byProvider.anthropic > 0);
    assert.ok(byProvider.openai > 0);
    assert.equal(hasMissingRate, false);
    assert.deepEqual(missingRateModels, []);
  });

  test("a rate-less model across rows surfaces via hasMissingRate/missingRateModels rather than silently pricing at $0", () => {
    const rows = [
      costRow({ cellKey: "c1", timestamp: "2026-08-01T00:00:00Z", billing_mode: "api", model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 500 }),
      costRow({ cellKey: "c2", timestamp: "2026-08-01T00:00:00Z", billing_mode: "api", model: "gpt-5.4", input_tokens: 1000, output_tokens: 500 }),
    ];
    const { hasMissingRate, missingRateModels } = priceRowsByProvider(rows);
    assert.equal(hasMissingRate, true);
    assert.deepEqual(missingRateModels, ["gpt-5.4"]);
  });

  // ── BLOCKING 2 (fix round): pin the aggregation loop itself, not just its
  // observable output on rows that happen to land in different buckets ─────
  test("accumulates -- not overwrites -- multiple rows landing in the SAME provider bucket", () => {
    const rows = [
      costRow({ cellKey: "c1", timestamp: "2026-08-01T00:00:00Z", billing_mode: "api", model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 500 }),
      costRow({ cellKey: "c2", timestamp: "2026-08-01T00:00:00Z", billing_mode: "api", model: "claude-haiku-4-5", input_tokens: 1000, output_tokens: 500 }),
    ];
    const firstAlone = priceRowByProvider(rows[0]).byProvider.anthropic;
    const secondAlone = priceRowByProvider(rows[1]).byProvider.anthropic;
    const { byProvider } = priceRowsByProvider(rows);
    // Both rows land in `anthropic`. An accumulator mutated from `+=` to `=`
    // (byProvider[p] = usd instead of (byProvider[p]||0) + usd) would survive
    // with only the SECOND row's value here -- assert the true sum, and
    // separately assert it is NOT just the last row's contribution.
    assert.ok(Math.abs(byProvider.anthropic - (firstAlone + secondAlone)) < 1e-9, "must equal the SUM of both rows' anthropic shares");
    assert.notEqual(byProvider.anthropic, secondAlone, "must not equal just the LAST row's contribution alone");
  });

  test("hasMissingRate/missingRateModels union holds even when the missing-rate row comes FIRST", () => {
    const rows = [
      costRow({ cellKey: "c1", timestamp: "2026-08-01T00:00:00Z", billing_mode: "api", model: "gpt-5.4", input_tokens: 1000, output_tokens: 500 }),
      costRow({ cellKey: "c2", timestamp: "2026-08-01T00:00:00Z", billing_mode: "api", model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 500 }),
    ];
    const { hasMissingRate, missingRateModels } = priceRowsByProvider(rows);
    // A last-row-wins union (missingRateModels reassigned per row instead of
    // accumulated into a Set) would report `false`/`[]` here, since the LAST
    // row (claude-sonnet-5) is priceable -- only a TRUE union catches the
    // FIRST row's gap.
    assert.equal(hasMissingRate, true, "a last-row-wins union would report false here");
    assert.deepEqual(missingRateModels, ["gpt-5.4"]);
  });
});

// ── providerOf: the model-id -> provider inference (issue #51) ──────────────
describe("providerOf", () => {
  test("infers anthropic from a claude-* id and openai from a gpt-*/openai-* id", () => {
    assert.equal(providerOf("claude-sonnet-5"), "anthropic");
    assert.equal(providerOf("claude-haiku-4-5"), "anthropic");
    assert.equal(providerOf("gpt-5.6-terra"), "openai");
    assert.equal(providerOf("openai-mid-tier"), "openai");
  });

  test("throws on an id with no recognized prefix rather than guessing", () => {
    assert.throws(() => providerOf("voyage-4-lite"), /cannot infer a provider/);
    assert.throws(() => providerOf(""), /non-empty string/);
  });
});

// ── priceRowByProvider: real-tokens attribution, the mixed-arm case ─────────
describe("priceRowByProvider — actual per-provider spend from tokens_by_model (issue #51)", () => {
  test("a single-model row attributes its whole cost to that model's provider", () => {
    const row = costRow({
      cellKey: "cell-1",
      timestamp: "2026-08-01T00:00:00Z",
      billing_mode: "api",
      model: "claude-sonnet-5",
      input_tokens: 1000,
      output_tokens: 500,
    });
    const { byProvider } = priceRowByProvider(row);
    assert.deepEqual(Object.keys(byProvider), ["anthropic"]);
    assert.ok(byProvider.anthropic > 0);
  });

  test("a mixed-arm row (arm G shape: 3 Anthropic + 2 OpenAI models in ONE cell) splits real spend across both providers -- never lands entirely on whichever model is listed first", () => {
    const row = costRow({
      cellKey: "cell-g",
      timestamp: "2026-08-01T00:00:00Z",
      billing_mode: "api",
      tokens_by_model: {
        // OpenAI listed FIRST here on purpose -- a flat "whichever model is
        // listed first" bug would put the ENTIRE row's cost under openai.
        "gpt-5.6-terra": { input_tokens: 500, output_tokens: 300 },
        "gpt-5.6-sol": { input_tokens: 500, output_tokens: 300 },
        "claude-haiku-4-5": { input_tokens: 500, output_tokens: 300 },
        "claude-sonnet-5": { input_tokens: 500, output_tokens: 300 },
        "claude-opus-5": { input_tokens: 500, output_tokens: 300 },
      },
    });
    const { byProvider } = priceRowByProvider(row);
    assert.ok(byProvider.anthropic > 0, "the 3 Anthropic models contribute a positive Anthropic share");
    assert.ok(byProvider.openai > 0, "the 2 OpenAI models contribute a positive OpenAI share");
    // Opus 5 alone ($5/$25) plus Sonnet 5 plus Haiku should not equal the two
    // OpenAI models' combined share at these token counts -- a coarse sanity
    // check that the split reflects real per-model rates, not e.g. an even
    // 50/50 split by provider count.
    assert.notEqual(byProvider.anthropic, byProvider.openai);
  });
});
