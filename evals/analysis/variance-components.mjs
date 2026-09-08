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
//   node evals/analysis/variance-components.mjs [--csv PATH] [--all-arms]
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
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
