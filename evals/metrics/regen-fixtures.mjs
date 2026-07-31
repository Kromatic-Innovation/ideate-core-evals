#!/usr/bin/env node
// regen-fixtures.mjs — generate REAL model embeddings for the frozen control
// texts and commit them as evals/metrics/fixtures/embeddings.json.
//
// ── Why this script exists, and why it must never run in CI ────────────────
// The hermetic embedder (../embedder.mjs `fixtureEmbedder`) is a pure
// text -> vector LOOKUP over a committed JSON file. A lookup table is only
// trustworthy if the vectors in it are genuine model output — a hand-authored
// or hash-derived vector could be shaped to make any control pass, which is
// exactly the failure the issue calls out: "a study that can't fail its own
// sanity checks isn't measuring anything." So this script is the ONE place
// in the repo allowed to import @huggingface/transformers, and it is a
// one-off generator, never imported by a test or by embedder.mjs itself.
// `node --test` must stay green with node_modules removed (see the repo-root
// hermetic proof run for this PR) — that only holds if no test file imports
// this script or the transformers package transitively.
//
// ── Model choice ─────────────────────────────────────────────────────────
// Xenova/all-MiniLM-L6-v2 (quantized) via @huggingface/transformers: a small
// (~23MB quantized) sentence-embedding model that runs fully offline once
// downloaded, no API key, no network at TEST time (only at REGEN time, to
// fetch the model weights + here, the control texts need no network at all
// since they're hardcoded strings). Verified in this sandbox: model loads in
// ~4s, produces 384-dim L2-normalized sentence embeddings.
//
// ── Usage ────────────────────────────────────────────────────────────────
//   npm install --save-dev @huggingface/transformers   (devDependency only —
//     see package.json comment; bare `node --test` never triggers this)
//   node evals/metrics/regen-fixtures.mjs
//
// Re-run this whenever evals/metrics/fixtures/control-texts.mjs changes.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ALL_FIXTURE_TEXTS } from "./fixtures/control-texts.mjs";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const OUT_PATH = fileURLToPath(new URL("./fixtures/embeddings.json", import.meta.url));

async function main() {
  // Imported lazily, inside main(), so that merely importing this MODULE
  // (e.g. an accidental import from a test) doesn't pull in
  // @huggingface/transformers at module-evaluation time. Belt-and-suspenders
  // on top of "no test imports this file" — see header.
  const { pipeline } = await import("@huggingface/transformers");

  console.log(`[regen-fixtures] loading ${MODEL_ID} ...`);
  const t0 = Date.now();
  const extractor = await pipeline("feature-extraction", MODEL_ID, { quantized: true });
  console.log(`[regen-fixtures] model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log(`[regen-fixtures] embedding ${ALL_FIXTURE_TEXTS.length} distinct texts ...`);
  const output = await extractor(ALL_FIXTURE_TEXTS, { pooling: "mean", normalize: true });

  // `output` is a batched tensor: dims = [n, dim]. Slice it back into one
  // plain number[] per input text, keyed by the exact text string (the
  // hermetic embedder's lookup key — see embedder.mjs).
  const [n, dim] = output.dims;
  if (n !== ALL_FIXTURE_TEXTS.length) {
    throw new Error(`regen-fixtures: expected ${ALL_FIXTURE_TEXTS.length} output rows, got ${n}`);
  }
  const flat = Array.from(output.data);
  const fixtures = {};
  for (let i = 0; i < n; i++) {
    fixtures[ALL_FIXTURE_TEXTS[i]] = flat.slice(i * dim, (i + 1) * dim);
  }

  const payload = {
    modelId: MODEL_ID,
    dim,
    generatedAt: new Date().toISOString(),
    pooling: "mean",
    normalized: true,
    count: n,
    vectors: fixtures,
  };
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`[regen-fixtures] wrote ${n} vectors (dim=${dim}) to ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((err) => {
  console.error("[regen-fixtures] failed:", err);
  process.exitCode = 1;
});
