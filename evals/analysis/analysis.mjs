#!/usr/bin/env node
// analysis.mjs — thin CLI orchestrator wiring frame -> fit ladder ->
// contrasts -> multiplicity -> pareto -> report -> out/*. Not itself an
// acceptance criterion (#46 asks for the modules + tests); this exists so
// the pieces can be run end-to-end against a real results/ store without
// hand-wiring them each time.
//
// Usage:
//   node evals/analysis/analysis.mjs --results-dir results --out-dir evals/analysis/out \
//     --response distinct_k --reference-arm A --panel-arms A2,B,C,D,E,F,G,H
//
// Requires ANALYSIS_SIDECAR-independent setup: the sidecar venv must exist
// at evals/analysis/sidecar/.venv (see sidecar/requirements.txt) — this CLI
// always uses the real sidecar runner, never a fake one (fakes are for
// fit.test.mjs only).

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ResultsStore } from "../../lib/store.mjs";
import { buildFrame, summarizeByArm } from "./frame.mjs";
import { buildRarefiedFrame, PoolsUnavailableError } from "./rarefiedFrame.mjs";
import { buildRegisteredFamily, evaluateSpec, registeredFamilySlotCount, applyHolmVerdicts } from "./contrasts.mjs";
import { holmBonferroni } from "./multiplicity.mjs";
import { paretoFrontier, costDiversityRatioByArm, seedFromString } from "./pareto.mjs";
import { renderParetoSvg } from "./plot.mjs";
import { runLadder, makeSidecarRunner, analysisHash as computeAnalysisHash } from "./fit.mjs";
import { RAREFACTION_TREATMENT } from "./rarefaction.mjs";
import { renderAnalysisDataCsv, renderLme4FitR } from "./reproducibility.mjs";
import { renderReport } from "./report.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { resultsDir: "results", outDir: join(__dirname, "out"), response: "distinct_k", referenceArm: "A", panelArms: null, delta: undefined, config: {}, poolField: "pool" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--results-dir") args.resultsDir = argv[++i];
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--response") args.response = argv[++i];
    else if (a === "--reference-arm") args.referenceArm = argv[++i];
    else if (a === "--panel-arms") args.panelArms = argv[++i].split(",");
    // H2/H4's registered default is delta=0 (buildRegisteredFamily()) -- this
    // flag exists ONLY to register an explicit margin later (§B2's pilot),
    // and doing so is recorded as a deviation from the current registration
    // (see contrasts.mjs's `deltaDeviatesFromRegistration`), never silently
    // absorbed as if it were always the registered test.
    else if (a === "--delta") args.delta = Number(argv[++i]);
    // Rarefaction (issue #73, docs/PREREGISTRATION.md Appendix C): H1's
    // registered estimand needs the SAME clusterDistanceThreshold distinct_k
    // was originally measured at (lib/manifest.mjs CONFIG_FIELDS) — there is
    // no default (rarefiedFrame.mjs refuses to guess one).
    else if (a === "--cluster-distance-threshold") args.config.clusterDistanceThreshold = Number(argv[++i]);
    else if (a === "--pool-field") args.poolField = argv[++i];
    else throw new Error(`analysis.mjs: unrecognized argument '${a}'`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  mkdirSync(args.outDir, { recursive: true });

  const store = new ResultsStore(args.resultsDir);
  // poolField is requested unconditionally (issue #73): no stored cell
  // carries one yet (frame.mjs's own header / Appendix C item 5), so today
  // every row's `pool` comes back undefined and the rarefied lane below
  // reports H1 as not computed -- see PoolsUnavailableError handling. Once
  // #8 (Phase 2a) starts writing embedded pools, this same CLI wiring picks
  // them up with no further change.
  const frame = buildFrame(store, { config: args.config, responseField: args.response, poolField: args.poolField });
  const panelArms = args.panelArms || frame.armLevels.filter((a) => a !== args.referenceArm);

  // ── Full-pool ladder — the response every hypothesis EXCEPT H1 is fit
  // against (H2/H3/H4 are registered "unaffected" by rarefaction, Appendix C
  // item 4), and what the Pareto/cost lanes stay on (item 3: distinct_k/$ is
  // "full-pool, self-correcting"). ───────────────────────────────────────────
  const ladder = await runLadder({
    rows: frame.rows.map((r) => ({ armId: r.armId, briefId: r.briefId, response: r.response })),
    armLevels: frame.armLevels,
    referenceArm: args.referenceArm,
    runner: makeSidecarRunner(),
  });

  if (!ladder.fit) {
    throw new Error(`analysis.mjs: ladder reached ${ladder.rung} (no confirmatory inference) — see history: ${JSON.stringify(ladder.history)}`);
  }

  // ── Rarefied lane — H1's registered estimand (Appendix C items 2/4/5).
  // A SEPARATE frame and a SEPARATE ladder fit from the full-pool one above:
  // H1's contrast (mean(panel arms) - referenceArm) is evaluated against
  // THIS fit, never the full-pool one. Only attempted for a metric Appendix
  // C item 3 actually registers as "rarefied" (distinct_k, poolFlexibility)
  // — buildRarefiedFrame() itself refuses any other metric, this is just the
  // faster "don't even try" path for e.g. a judge-score response. ──────────
  let rarefiedLadder = null;
  let rarefiedFrame = null;
  let rarefiedUnavailableReason = null;
  if (RAREFACTION_TREATMENT[args.response] === "rarefied") {
    try {
      rarefiedFrame = buildRarefiedFrame(frame, {
        armIds: [args.referenceArm, ...panelArms],
        threshold: args.config.clusterDistanceThreshold,
        metric: args.response,
      });
    } catch (err) {
      if (err instanceof PoolsUnavailableError) {
        // Registered, expected state until #8 (Phase 2a) populates pools —
        // never silently fall through to the full-pool fit for H1 (that is
        // exactly the defect Appendix C exists to close). Any OTHER error
        // (MixedPoolCoverageError, a missing/wrong threshold, a disagreeing
        // stored scalar) is a real problem and must keep propagating.
        rarefiedUnavailableReason = err.message;
      } else {
        throw err;
      }
    }
    if (rarefiedFrame) {
      rarefiedLadder = await runLadder({
        rows: rarefiedFrame.rows.map((r) => ({ armId: r.armId, briefId: r.briefId, response: r.response })),
        armLevels: rarefiedFrame.armLevels,
        referenceArm: args.referenceArm,
        runner: makeSidecarRunner(),
      });
      if (!rarefiedLadder.fit) {
        // Sidecar-unavailable already propagated as SidecarUnavailableError
        // out of runLadder/fitViaSidecar above, uncaught — this is reachable
        // only for a genuine R3 (every rung's diagnostics failed), which is
        // as much a hard stop for the rarefied lane as it already is for the
        // full-pool one two lines up.
        throw new Error(
          `analysis.mjs: rarefied ladder reached ${rarefiedLadder.rung} (no confirmatory inference for H1's registered estimand) — see history: ${JSON.stringify(rarefiedLadder.history)}`,
        );
      }
    }
  }

  const family = buildRegisteredFamily({ referenceArm: args.referenceArm, panelArms, delta: args.delta });
  // One evaluateSpec() result per hypothesis (H3's two sub-contrasts are
  // combined internally into a single IUT p-value -- see contrasts.mjs) --
  // registeredResults is therefore already flat, 5 entries, H1..H5. H1 is
  // the ONE entry evaluated against the rarefied fit (when available) --
  // every other entry keeps using the full-pool `ladder.fit`, unchanged.
  const registeredResults = family.map((spec) => {
    if (spec.id !== "H1") return evaluateSpec(spec, ladder.fit);
    if (rarefiedLadder && rarefiedLadder.fit) return evaluateSpec(spec, rarefiedLadder.fit);
    // No rarefied fit available -- report H1 as NOT COMPUTED (the same
    // `{unimplemented: true, p: 1}` shape H5 already uses) rather than
    // fabricating a number or silently falling back to the full-pool fit.
    return {
      id: "H1",
      description: spec.description,
      unimplemented: true,
      reason: rarefiedUnavailableReason || "rarefied lane did not run",
      p: 1,
    };
  });
  const holmAdjusted = holmBonferroni(
    registeredResults.map((r) => r.p),
    { familySize: registeredFamilySlotCount(family) },
  );
  const verdicts = applyHolmVerdicts(registeredResults, holmAdjusted);

  // Pareto / cost lanes stay on the FULL-POOL frame -- distinct_k/dollar is
  // registered "full-pool, self-correcting" (Appendix C item 3), never
  // rarefied.
  const armSummaries = summarizeByArm(frame);
  const paretoPoints = paretoFrontier(armSummaries.map((a) => ({ armId: a.armId, meanCostUsd: a.meanCostUsd, meanResponse: a.meanResponse })));
  const costRatioByArm = costDiversityRatioByArm(frame, { seed: seedFromString(frame.configHash) });

  const hash = computeAnalysisHash(ladder.fit);

  writeFileSync(join(args.outDir, "analysis-data.csv"), renderAnalysisDataCsv(frame));
  writeFileSync(join(args.outDir, "lme4-fit.R"), renderLme4FitR({ responseField: frame.responseField, armLevels: frame.armLevels, referenceArm: args.referenceArm }));
  writeFileSync(
    join(args.outDir, "fit.json"),
    JSON.stringify(
      {
        rung: ladder.rung,
        fit: ladder.fit,
        history: ladder.history,
        robustnessCheck: ladder.robustnessCheck,
        rarefied: rarefiedLadder
          ? { rung: rarefiedLadder.rung, fit: rarefiedLadder.fit, history: rarefiedLadder.history, robustnessCheck: rarefiedLadder.robustnessCheck }
          : { unavailableReason: rarefiedUnavailableReason },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(args.outDir, "pareto.svg"), renderParetoSvg(paretoPoints));
  writeFileSync(
    join(args.outDir, "REPORT.md"),
    renderReport({
      frame,
      ladder,
      registeredResults: verdicts,
      holmAdjusted,
      paretoPoints,
      costRatioByArm,
      analysisHash: hash,
      rarefiedFrame,
      rarefiedLadder,
      rarefiedUnavailableReason,
    }),
  );

  return {
    frame,
    ladder,
    registeredResults: verdicts,
    holmAdjusted,
    paretoPoints,
    costRatioByArm,
    analysisHash: hash,
    rarefiedFrame,
    rarefiedLadder,
    rarefiedUnavailableReason,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
