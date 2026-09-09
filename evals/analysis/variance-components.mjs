#!/usr/bin/env node
// variance-components.mjs -- reproduce the variance components registered in
// docs/PREREGISTRATION.md Appendix G item 1, from the committed per-cell CSV.
//
// Why this exists: Appendix G supersedes Appendix E item 7's sigma^2_ba = 77.85,
// a number that was "reported, not verified against a committed artifact in this
// repo" -- transcribed from an issue body and never independently re-run. That
// is exactly the provenance this repo's own discipline exists to refuse, so the
// number replacing it ships with the script that produced it rather than with a
// prose description of a script someone else would have to reimplement.
//
// Two quantities, computed two different ways, deliberately:
//
//   - `brief` and `brief:arm` come from the R0 mixed model, via the SAME sidecar
//     (evals/analysis/sidecar/fit_mixedlm.py) the registered analysis ladder
//     uses. Nothing is re-fit here in JS.
//   - `sigma^2_e` is NOT a sidecar output. It is the pooled within-(arm x brief)
//     variance across replicate pairs -- the quantity Appendix E item 7's own
//     "pooled within-(arm x brief) residual variance" line names -- computed here
//     directly from the same rows.
//
// This builds NO hypothesis family. See issue #145 and Appendix F item 7: H1 is
// estimable under any arm subset, so a subset run can return a fabricated
// contrast wearing a registered hypothesis's name. Nothing here goes near
// contrasts.mjs.
//
// Usage:
//   node evals/analysis/variance-components.mjs [--csv PATH] [--all-arms] [--n60-scale]
//
// --n60-scale prints Appendix I item 3's ~60-pool basis and Stage 1b's sizing.
// Appendix G item 4 registered that the ~30 table transfers to nothing else;
// this is the separate basis that bound requires, including the one quantity
// in it that is an ASSUMPTION rather than a measurement.
//
// --all-arms fits across every completed arm INCLUDING the N=10 and N=60 ones.
// That is the fit Appendix G item 1 records but explicitly does not use as the
// basis: distinct_k is a count, its variance scales with the count, and a fit
// across mixed pool sizes forces one interaction term to absorb the
// heteroscedasticity. Both are printed so the difference is inspectable.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const DEFAULT_CSV = join(REPO_ROOT, "docs", "study1-stage1a-cells.csv");
const SIDECAR = join(HERE, "sidecar", "fit_mixedlm.py");
const VENV_PYTHON = join(HERE, "sidecar", ".venv", "bin", "python");

// The registered matched-N=30 basis: the six Stage 1a arms whose
// totalIdeasRequested is 30. Named explicitly rather than derived from
// arms.config.json, because the basis is a REGISTERED set (Appendix G item 1) --
// if a future arms.config edit changed which arms ask for 30 ideas, this script
// must keep reproducing the registered number, not silently follow the config.
export const MATCHED_N30_ARMS = ["S1-C0", "S1-ELOW", "S1-EMAX", "S1-SPRAG", "S1-SCONTRA", "S1-DIRECT"];
export const REFERENCE_ARM = "S1-C0";

// ── The ~60-pool basis (Appendix I item 3) ──────────────────────────────────
// Stage 1b's contrasts rarefy at ~60, and Appendix G item 4 registered that
// its table is valid at ~30 and nowhere else. Two named arms carry the whole
// transport:
//
//   - sigma^2_e at ~60 is MEASURED, at S1-N60, and needs no scaling.
//   - sigma^2_ba at ~60 is NOT estimable from Stage 1a -- an interaction term
//     needs two or more arms at that pool size and Stage 1a ran exactly one --
//     so it is TRANSPORTED from the matched-N=30 fit by the ratio below,
//     which is a registered ASSUMPTION and is labelled as one everywhere.
//
// The ratio is S1-N60 over S1-C0 and not over the pooled matched residual,
// because those two arms differ in pool size and in nothing else. Pooling
// drags in S1-SPRAG, whose within-cell variance is 18.17 -- a stance effect on
// output stability at the SAME N, roughly four times any other arm's -- and
// produces a ratio BELOW ONE for a quantity argued to grow with pool size.
export const N60_ARM = "S1-N60";
export const N30_CENTRE_ARM = "S1-C0";

export function readCells(csvPath) {
  const lines = readFileSync(csvPath, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => Object.fromEntries(line.split(",").map((v, i) => [header[i], v])));
}

/**
 * Pooled within-(arm x brief) variance: sum of squared deviations from each
 * cell's own mean, over the summed within-cell degrees of freedom.
 *
 * Cells with a single observation contribute 0 df and are skipped rather than
 * contributing a spurious 0 -- a failed replicate must not read as "this cell
 * had no variance."
 */
export function pooledWithinCellVariance(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.arm}|${row.brief}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Number(row.distinct_k));
  }
  let ss = 0;
  let df = 0;
  let cells = 0;
  for (const values of groups.values()) {
    if (values.length < 2) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    for (const v of values) ss += (v - mean) ** 2;
    df += values.length - 1;
    cells += 1;
  }
  if (df === 0) throw new Error("pooledWithinCellVariance: no (arm x brief) cell has more than one replicate -- sigma^2_e is not estimable");
  return { sigma2: ss / df, sd: Math.sqrt(ss / df), df, cells };
}

/**
 * The ~60-pool basis (Appendix I item 3), derived from named arms only.
 *
 * Returns every quantity the appendix registers, so the appendix's table is
 * reproducible rather than transcribed -- the same discipline Appendix G item
 * 5 established after a two-brief estimate became binding on a whole
 * replication plan by being carried, unverified, out of an issue body.
 *
 * @param {Array<object>} completedRows  CSV rows with state === "completed"
 * @param {number} sigma2BriefArmAt30    the registered matched-N=30 brief:arm
 */
export function n60ScaleBasis(completedRows, sigma2BriefArmAt30) {
  const at = (arm) => pooledWithinCellVariance(completedRows.filter((r) => r.arm === arm));
  const n60 = at(N60_ARM);
  const centre = at(N30_CENTRE_ARM);
  const varianceRatio = n60.sigma2 / centre.sigma2;

  // The corroborating mechanism, computed rather than asserted: distinct_k is
  // a COUNT, so if its variance tracks its mean the variance ratio should be
  // near the mean ratio. Appendix G item 1 already invokes count-variance
  // scaling to explain the inflated pooled interaction; here the same
  // mechanism gives an independent route to the same number.
  const meanOf = (arm) => {
    const ys = completedRows.filter((r) => r.arm === arm).map((r) => Number(r.distinct_k));
    return ys.reduce((a, b) => a + b, 0) / ys.length;
  };
  const meanRatio = meanOf(N60_ARM) / meanOf(N30_CENTRE_ARM);

  // A variance ratio on df 12 against df 12 is imprecise, and the sizing
  // inherits that. F(0.975, 12, 12) = 3.277 gives the two-sided 95% interval
  // on the ratio; the appendix registers the assumption WITH this interval
  // rather than presenting 1.95 as if it were measured.
  const F_975_12_12 = 3.277;
  return {
    sigma2eAt60: n60.sigma2,
    sigma2eAt30Centre: centre.sigma2,
    dfAt60: n60.df,
    dfAt30Centre: centre.df,
    varianceRatio,
    varianceRatioCI: [varianceRatio / F_975_12_12, varianceRatio * F_975_12_12],
    meanRatio,
    sigma2BriefArmAt60: sigma2BriefArmAt30 * varianceRatio,
  };
}

/** The registered SE of a two-arm contrast under the R0 model (§3.4). */
export function contrastSE(sigma2BriefArm, sigma2Residual, briefs, replicates) {
  return Math.sqrt(2 * (sigma2BriefArm / briefs + sigma2Residual / (briefs * replicates)));
}

function fitR0(rows) {
  const armLevels = [...new Set(rows.map((r) => r.arm))].sort();
  const request = {
    rung: "R0",
    rows: rows.map((r) => ({ arm: r.arm, brief: r.brief, y: Number(r.distinct_k) })),
    armLevels,
    referenceArm: REFERENCE_ARM,
  };
  const proc = spawnSync(VENV_PYTHON, [SIDECAR], { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (proc.status !== 0) {
    throw new Error(`fit_mixedlm.py exited ${proc.status}: ${proc.stderr || "(no stderr)"} -- is the sidecar venv present at ${VENV_PYTHON}?`);
  }
  return JSON.parse(proc.stdout);
}

function report(label, rows) {
  const fit = fitR0(rows);
  const residual = pooledWithinCellVariance(rows);
  const seIndex = fit.coefficientNames.findIndex((n) => n !== "Intercept");
  const achievedSE = seIndex >= 0 ? Math.sqrt(fit.vcov[seIndex][seIndex]) : null;
  const briefs = new Set(rows.map((r) => r.brief)).size;

  console.log(`\n=== ${label} (n = ${fit.n}, converged = ${fit.converged}) ===`);
  console.log(`  brief                     ${fit.varianceComponents.brief.toFixed(4)}`);
  console.log(`  brief:arm                 ${fit.varianceComponents["brief:arm"].toFixed(4)}`);
  console.log(`  residual (pooled within)  ${residual.sigma2.toFixed(4)}  (sd ${residual.sd.toFixed(3)}, df ${residual.df}, ${residual.cells} cells)`);
  if (achievedSE !== null) {
    const predicted = contrastSE(fit.varianceComponents["brief:arm"], residual.sigma2, briefs, 2);
    console.log(`  achieved contrast SE      ${achievedSE.toFixed(4)}  (formula at B=${briefs}, R=2: ${predicted.toFixed(4)})`);
  }
  return { fit, residual };
}

function printSETable(sigma2BriefArm, sigma2Residual) {
  console.log("\n=== SE of a two-arm contrast, on the matched-N=30 components (Appendix G item 2) ===");
  console.log("  B     R=1    R=2    R=3    R=5");
  for (const B of [6, 12, 24, 48]) {
    const cells = [1, 2, 3, 5].map((R) => contrastSE(sigma2BriefArm, sigma2Residual, B, R).toFixed(2).padStart(6));
    console.log(`  ${String(B).padEnd(4)}${cells.join(" ")}`);
  }
}

function main(argv) {
  const csvIndex = argv.indexOf("--csv");
  const csvPath = csvIndex >= 0 ? argv[csvIndex + 1] : DEFAULT_CSV;
  const completed = readCells(csvPath).filter((r) => r.state === "completed");

  const matched = completed.filter((r) => MATCHED_N30_ARMS.includes(r.arm));
  const { fit, residual } = report("matched N=30 -- THE REGISTERED BASIS", matched);

  if (argv.includes("--all-arms")) {
    report("pooled across N -- recorded, NOT the basis (Appendix G item 1)", completed);
  }

  printSETable(fit.varianceComponents["brief:arm"], residual.sigma2);

  if (argv.includes("--n60-scale")) {
    printN60Basis(n60ScaleBasis(completed, fit.varianceComponents["brief:arm"]), completed);
  }
}

/** Appendix I item 3's table, and the Stage 1b sizing that follows from it. */
function printN60Basis(b, completed) {
  console.log("\n=== the ~60-pool basis -- Stage 1b (Appendix I item 3) ===");
  console.log(`  sigma^2_e at ~60 (${N60_ARM}, MEASURED)      ${b.sigma2eAt60.toFixed(4)}  (sd ${Math.sqrt(b.sigma2eAt60).toFixed(3)}, df ${b.dfAt60})`);
  console.log(`  sigma^2_e at ~30 (${N30_CENTRE_ARM}, MEASURED)       ${b.sigma2eAt30Centre.toFixed(4)}  (sd ${Math.sqrt(b.sigma2eAt30Centre).toFixed(3)}, df ${b.dfAt30Centre})`);
  console.log(`  variance ratio (the ASSUMPTION)          ${b.varianceRatio.toFixed(4)}  95% CI ${b.varianceRatioCI[0].toFixed(3)} - ${b.varianceRatioCI[1].toFixed(3)}`);
  console.log(`  mean ratio (independent corroboration)   ${b.meanRatio.toFixed(4)}  -- count-variance scaling predicts these agree`);
  console.log(`  sigma^2_ba at ~60 (TRANSPORTED)          ${b.sigma2BriefArmAt60.toFixed(4)}  -- NOT estimable from Stage 1a; one arm ran at this pool size`);

  console.log("\n  Every arm's within-cell variance, so the ratio's denominator is inspectable:");
  const arms = [...new Set(completed.map((r) => r.arm))].sort();
  for (const arm of arms) {
    const v = pooledWithinCellVariance(completed.filter((r) => r.arm === arm));
    console.log(`    ${arm.padEnd(12)} ${v.sigma2.toFixed(4).padStart(9)}  (df ${v.df})`);
  }

  // 2.80 is the unadjusted 80%-power multiplier at alpha=0.05 two-sided;
  // 3.08 is the same at alpha=0.025, which is what Holm's first step spends
  // on a family of TWO registered contrasts. The registered MDE is the
  // adjusted one -- no test will run at the unadjusted number.
  console.log("\n  SE and MDE at the ~60 basis (MDE at 80% power; Holm m=2 -> 3.08x, unadjusted 2.80x):");
  console.log("    B     R=1     R=2     R=3    MDE(R=2, Holm)");
  for (const B of [6, 12, 24, 36, 48]) {
    const ses = [1, 2, 3].map((R) => contrastSE(b.sigma2BriefArmAt60, b.sigma2eAt60, B, R));
    console.log(`    ${String(B).padEnd(4)}${ses.map((s) => s.toFixed(3).padStart(7)).join(" ")}   ${(3.08 * ses[1]).toFixed(2)}`);
  }

  console.log("\n  Sensitivity of the REGISTERED design (B=24, R=2) across the ratio's 95% CI:");
  for (const [label, ratio] of [["lower", b.varianceRatioCI[0]], ["point", b.varianceRatio], ["upper", b.varianceRatioCI[1]]]) {
    const sigma2BaAt30 = b.sigma2BriefArmAt60 / b.varianceRatio;
    const se = contrastSE(sigma2BaAt30 * ratio, b.sigma2eAt60, 24, 2);
    console.log(`    ${label.padEnd(6)} ratio ${ratio.toFixed(3).padStart(6)}  SE ${se.toFixed(3)}  MDE(Holm) ${(3.08 * se).toFixed(2)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
