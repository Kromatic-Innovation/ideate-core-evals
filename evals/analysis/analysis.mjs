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
import { buildRegisteredFamily, evaluateSpec, registeredFamilySlotCount, applyHolmVerdicts } from "./contrasts.mjs";
import { holmBonferroni } from "./multiplicity.mjs";
import { paretoFrontier, costDiversityRatioByArm, seedFromString } from "./pareto.mjs";
import { renderParetoSvg } from "./plot.mjs";
import { runLadder, makeSidecarRunner, analysisHash as computeAnalysisHash } from "./fit.mjs";
import { renderAnalysisDataCsv, renderLme4FitR } from "./reproducibility.mjs";
import { renderReport } from "./report.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { resultsDir: "results", outDir: join(__dirname, "out"), response: "distinct_k", referenceArm: "A", panelArms: null, delta: undefined, config: {} };
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
    else throw new Error(`analysis.mjs: unrecognized argument '${a}'`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  mkdirSync(args.outDir, { recursive: true });

  const store = new ResultsStore(args.resultsDir);
  const frame = buildFrame(store, { config: args.config, responseField: args.response });
  const panelArms = args.panelArms || frame.armLevels.filter((a) => a !== args.referenceArm);

  const ladder = await runLadder({
    rows: frame.rows.map((r) => ({ armId: r.armId, briefId: r.briefId, response: r.response })),
    armLevels: frame.armLevels,
    referenceArm: args.referenceArm,
    runner: makeSidecarRunner(),
  });

  if (!ladder.fit) {
    throw new Error(`analysis.mjs: ladder reached ${ladder.rung} (no confirmatory inference) — see history: ${JSON.stringify(ladder.history)}`);
  }

  const family = buildRegisteredFamily({ referenceArm: args.referenceArm, panelArms, delta: args.delta });
  // One evaluateSpec() result per hypothesis (H3's two sub-contrasts are
  // combined internally into a single IUT p-value -- see contrasts.mjs) --
  // registeredResults is therefore already flat, 5 entries, H1..H5.
  const registeredResults = family.map((spec) => evaluateSpec(spec, ladder.fit));
  const holmAdjusted = holmBonferroni(
    registeredResults.map((r) => r.p),
    { familySize: registeredFamilySlotCount(family) },
  );
  const verdicts = applyHolmVerdicts(registeredResults, holmAdjusted);

  const armSummaries = summarizeByArm(frame);
  const paretoPoints = paretoFrontier(armSummaries.map((a) => ({ armId: a.armId, meanCostUsd: a.meanCostUsd, meanResponse: a.meanResponse })));
  const costRatioByArm = costDiversityRatioByArm(frame, { seed: seedFromString(frame.configHash) });

  const hash = computeAnalysisHash(ladder.fit);

  writeFileSync(join(args.outDir, "analysis-data.csv"), renderAnalysisDataCsv(frame));
  writeFileSync(join(args.outDir, "lme4-fit.R"), renderLme4FitR({ responseField: frame.responseField, armLevels: frame.armLevels, referenceArm: args.referenceArm }));
  writeFileSync(join(args.outDir, "fit.json"), JSON.stringify({ rung: ladder.rung, fit: ladder.fit, history: ladder.history, robustnessCheck: ladder.robustnessCheck }, null, 2));
  writeFileSync(join(args.outDir, "pareto.svg"), renderParetoSvg(paretoPoints));
  writeFileSync(
    join(args.outDir, "REPORT.md"),
    renderReport({ frame, ladder, registeredResults: verdicts, holmAdjusted, paretoPoints, costRatioByArm, analysisHash: hash }),
  );

  return { frame, ladder, registeredResults: verdicts, holmAdjusted, paretoPoints, costRatioByArm, analysisHash: hash };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
