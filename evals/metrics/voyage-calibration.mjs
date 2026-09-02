// voyage-calibration.mjs — the PRODUCTION clustering threshold, calibrated
// in Voyage-4-lite space (issue #42). Analogous to calibration.mjs (which
// derives the MiniLM-space threshold from the committed embeddings.json),
// this module reads the committed, already-generated
// ./fixtures/voyage-calibration-result.json at module load and re-exposes
// its fields as named constants. Module load is INERT — a JSON.parse of a
// committed file, no network, exactly like calibration.mjs's own pattern —
// so importing this module never breaks `npm test` or requires
// VOYAGE_API_KEY.
//
// ./fixtures/voyage-calibration-result.json is produced by running
// ./calibrate-voyage.mjs --write (opt-in, live, billed — see that file's
// header) against a real VOYAGE_API_KEY. It is NOT regenerated at import
// time or at test time; re-running calibrate-voyage.mjs and committing the
// refreshed JSON is the only way this constant changes, mirroring how
// regen-fixtures.mjs is the only way embeddings.json (and therefore the
// MiniLM CLUSTER_DISTANCE_THRESHOLD) changes.
//
// ── Why this exists as a SEPARATE constant from calibration.mjs's ──────────
// CLUSTER_DISTANCE_THRESHOLD (rather than just overwriting that export) ────
// calibration.mjs's CLUSTER_DISTANCE_THRESHOLD is derived from, and only
// valid for, the MiniLM fixture embedder — every hermetic test in this
// directory embeds with fixtureEmbedder(FIXTURES) (MiniLM), so hermetic
// tests must keep using that number. VOYAGE_CLUSTER_DISTANCE_THRESHOLD below
// is the number production code (a live Voyage embedder, e.g.
// phase0.mjs / evals/run.mjs's `--phase 0`) must use instead. Two
// distinct constants for two distinct embedding spaces — collapsing them
// into one is exactly the defect issue #42 fixes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RESULT_PATH = fileURLToPath(new URL("./fixtures/voyage-calibration-result.json", import.meta.url));

const _record = JSON.parse(readFileSync(RESULT_PATH, "utf8"));

/** The full durable calibration record — threshold, pair-set hash, embedder
 * id, selection rule, achieved balanced accuracy, and the narrow-fixture
 * transfer-check findings. See ./calibrate-voyage.mjs for how it's produced. */
export const VOYAGE_CALIBRATION_RECORD = _record;

/** The Voyage-4-lite-calibrated clustering distance threshold. Use this (not
 * calibration.mjs's CLUSTER_DISTANCE_THRESHOLD) for any distinct_k/clustering
 * computation over vectors from the live Voyage embedder. */
export const VOYAGE_CLUSTER_DISTANCE_THRESHOLD = _record.clusterDistanceThreshold;
