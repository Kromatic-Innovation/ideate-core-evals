// report.mjs — renders REPORT.md's analysis sections from an already-run
// analysis (the frame, the fitted rungs, the evaluated contrasts, the
// Pareto frontier). Pure string rendering — no I/O, no computation; every
// number it prints was computed by frame.mjs/contrasts.mjs/multiplicity.mjs/
// pareto.mjs/fit.mjs. Keeping it pure is what makes it independently
// testable without a store or a sidecar.

function fmt(n, digits = 3) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return Number(n).toFixed(digits);
}

function ciStr(ci, digits = 3) {
  return `[${fmt(ci[0], digits)}, ${fmt(ci[1], digits)}]`;
}

/**
 * @param {object} input
 *   @param {ReturnType<typeof import("./frame.mjs").buildFrame>} input.frame
 *   @param {{rung: string, fit: object|null}} input.ladder     runLadder() result
 *   @param {Array<object>} input.registeredResults    evaluateSpec() output for
 *                                                       H1..H5 (one entry each —
 *                                                       H3's two sub-contrasts
 *                                                       are combined into a
 *                                                       single IUT entry, see
 *                                                       contrasts.mjs), already
 *                                                       run through
 *                                                       contrasts.mjs's
 *                                                       applyHolmVerdicts() —
 *                                                       every entry (besides
 *                                                       unimplemented) carries
 *                                                       `holmP` and
 *                                                       `supported`/`significant`;
 *                                                       renderReport() never
 *                                                       recomputes a verdict
 *                                                       from a raw p or CI.
 *   @param {Array<object>} [input.exploratoryResults]  evaluateSpec() output, exploratory
 *   @param {number[]} [input.bhAdjusted]
 *   @param {Array<object>} input.paretoPoints          pareto.mjs paretoFrontier() output
 *   @param {Record<string, object>} input.costRatioByArm  pareto.mjs costDiversityRatioByArm() output
 *   @param {string} input.analysisHash
 *   @param {ReturnType<typeof import("./rarefiedFrame.mjs").buildRarefiedFrame>|null} [input.rarefiedFrame]
 *     H1's rarefied frame (issue #73, docs/PREREGISTRATION.md Appendix C) —
 *     null when rarefied `distinct_k` could not be computed (no per-cell
 *     pools in the store yet). When present, every row carries BOTH
 *     `responseFullPool` and `response` (rarefied) — Appendix C item 5
 *     registers reporting both, never the rarefied number alone.
 *   @param {{rung: string}|null} [input.rarefiedLadder]  runLadder() result
 *     for the rarefied lane, for the rung line.
 *   @param {string} [input.rarefiedUnavailableReason]  set when
 *     `rarefiedFrame` is null — printed verbatim rather than silently
 *     omitting the section (never let a reader assume rarefaction ran).
 * @returns {string} full REPORT.md content
 */
export function renderReport(input) {
  const {
    frame,
    ladder,
    registeredResults,
    holmAdjusted,
    exploratoryResults = [],
    bhAdjusted = [],
    paretoPoints,
    costRatioByArm,
    analysisHash,
    rarefiedFrame = null,
    rarefiedLadder = null,
    rarefiedUnavailableReason,
  } = input;

  const lines = [];
  lines.push("# Analysis report");
  lines.push("");
  lines.push(`Response: \`${frame.responseField}\`. configHash: \`${frame.configHash}\`. analysisHash: \`${analysisHash}\`.`);
  lines.push("");
  // Deliberately scoped to "full-pool lane" (issue #73 fix round): this rung
  // is the FULL-POOL ladder's — the one H2-H5 (and the Pareto/cost lanes)
  // are fit on. H1, when rarefied `distinct_k` is available, is fit on a
  // SEPARATE ladder that can land on a different rung — printing this line
  // as an unqualified global "Fitted at rung X" directly above the H1..H5
  // table would misleadingly attribute H1's rung to this one too. The
  // rarefied lane's own rung/history is printed in the Rarefaction section
  // below, and any divergence between the two is flagged there explicitly.
  lines.push(`Full-pool lane (H2-H5, Pareto, cost lane) fitted at rung **${ladder.rung}**${ladder.rung === "R3" ? " — no confirmatory inference; descriptive only." : "."}`);
  if (ladder.history && ladder.history.length) {
    lines.push("");
    lines.push("Full-pool ladder history:");
    for (const step of ladder.history) {
      lines.push(`- ${step.rung}: ${step.descended ? `descended (${step.reason})` : "held"}`);
    }
  }
  lines.push("");

  lines.push("## Registered hypotheses (Holm-Bonferroni, family of 5 slots across H1-H5 -- H3 is a single intersection-union test)");
  lines.push("");
  lines.push("| ID | Description | Estimate | 95% CI | Holm-adjusted p | Verdict |");
  lines.push("|---|---|---|---|---|---|");
  const flatRegistered = registeredResults.flat();
  for (let i = 0; i < flatRegistered.length; i++) {
    const r = flatRegistered[i];
    if (r.unimplemented) {
      lines.push(`| ${r.id} | ${r.description ? `${r.description} — ` : ""}(${r.reason || "not wired"}) | — | — | — | unimplemented |`);
      continue;
    }
    // Verdict is read from applyHolmVerdicts()'s output ONLY (r.holmP +
    // r.supported/r.significant) -- never recomputed here from a raw CI or
    // a bare `holmAdjusted[i]` lookup, which is exactly the bug (#46 QA
    // MUST #1) that let H2/H3/H4's verdicts escape multiplicity correction.
    // Keyed off `r.oneSided`, the SAME discriminator applyHolmVerdicts() used
    // to WRITE `supported` vs `significant` -- not `r.kind`, which is only
    // accidentally correct today (H1 is the sole "superiority"/two-sided
    // entry; any future two-sided hypothesis with a different `kind` would
    // read the wrong field silently -- #46 QA SHOULD).
    const adj = r.holmP ?? (holmAdjusted ? holmAdjusted[i] : undefined);
    const verdict = r.oneSided
      ? (r.supported ? "supported" : "not supported")
      : (r.significant ? "significant" : "not significant");
    const deviationNote = r.deltaDeviatesFromRegistration ? ` (delta=${r.delta}, DEVIATES from registration)` : "";
    // H3 (kind: "iut-max-p") consumes exactly ONE Holm slot/verdict, but
    // §6.2 makes effect sizes with 95% CIs the headline, not p-values -- so
    // both underlying sub-contrast estimates/CIs (the ones that actually
    // determine the binding component) still need to be visible, not just
    // the single one that happened to bind. Rendered as extra lines inside
    // the Estimate cell (GFM table cells support <br>) rather than as
    // separate table rows, since separate rows would silently resurrect the
    // two-slot framing BLOCKER 2 reverted.
    const estimateCell = r.components
      ? [`binding: ${fmt(r.estimate)}`, ...r.components.map((c) => `${c.id}: ${fmt(c.estimate)} (raw p=${fmt(c.p, 4)})`)].join("<br>")
      : fmt(r.estimate);
    const ciCell = r.components
      ? [`binding: ${ciStr(r.ci)}`, ...r.components.map((c) => `${c.id}: ${ciStr(c.ci)}`)].join("<br>")
      : ciStr(r.ci);
    lines.push(`| ${r.id} | ${(r.description || "")}${deviationNote} | ${estimateCell} | ${ciCell} | ${fmt(adj, 4)} | ${verdict} |`);
  }
  lines.push("");

  lines.push("## Rarefaction — H1's registered estimand (docs/PREREGISTRATION.md Appendix C)");
  lines.push("");
  if (rarefiedFrame) {
    const rarefiedRung = rarefiedLadder ? rarefiedLadder.rung : "n/a";
    lines.push(
      `Every pool in H1's contrast rarefied to the minimum pool size actually present (rarefiedN, per row below), ` +
        `Appendix C item 2. H1 above is evaluated against the RAREFIED value, fitted on its OWN ladder at rung **${rarefiedRung}** ` +
        "(a SEPARATE fit from the full-pool lane's rung reported above — H1's rung and H2-H5's rung are never the same statement). " +
        "Both values are reported (Appendix C item 5) — full-pool distinct_k is a secondary descriptive, never the registered estimand.",
    );
    // Rung divergence is a real, silent risk of the two-ladder design (issue
    // #73 fix round): cell inclusion cannot diverge (rarefiedFrame's rows
    // are always a subset of the full-pool frame's, same cfg), but the RUNG
    // each independently descends to can — H1 could be read off an R2
    // pure-Node fit while H2-H5 come from R0, with no cross-check unless
    // this is surfaced. Flag it plainly rather than let two different rungs
    // sit in the same report unremarked.
    if (rarefiedLadder && rarefiedRung !== ladder.rung) {
      lines.push("");
      lines.push(
        `**Rung divergence:** the full-pool lane landed on **${ladder.rung}** while the rarefied lane landed on **${rarefiedRung}** — ` +
          "H1 and H2-H5 were fit with different diagnostics-driven fallback behavior. Not necessarily wrong (each ladder descends " +
          "independently per B7), but a reviewer reproducing H1 must use lme4-fit-rarefied.R / the rarefied rung, not the full-pool one above.",
      );
    }
    if (rarefiedLadder && rarefiedLadder.history && rarefiedLadder.history.length) {
      lines.push("");
      lines.push("Rarefied ladder history:");
      for (const step of rarefiedLadder.history) {
        lines.push(`- ${step.rung}: ${step.descended ? `descended (${step.reason})` : "held"}`);
      }
    }
    lines.push("");
    lines.push("| Cell | Arm | Pool size | Rarefied N | Full-pool `distinct_k` | Rarefied `distinct_k` |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of rarefiedFrame.rows) {
      lines.push(`| ${r.cellKey} | ${r.armId} | ${r.poolSize} | ${r.rarefiedN} | ${fmt(r.responseFullPool)} | ${fmt(r.response)} |`);
    }
  } else {
    lines.push(
      `**Rarefied \`distinct_k\` NOT COMPUTED** — ${rarefiedUnavailableReason || "no per-cell pools in the store yet"}. ` +
        "H1 above is reported `unimplemented` (p=1, occupies its Holm slot) rather than falling back to the full-pool contrast, " +
        "per Appendix C item 5: rarefied distinct_k is H1's registered estimand and the full-pool value is never a silent substitute for it.",
    );
  }
  lines.push("");

  if (exploratoryResults.length) {
    lines.push("## Exploratory contrasts (Benjamini-Hochberg, labeled exploratory)");
    lines.push("");
    lines.push("| ID | Estimate | 95% CI | BH-adjusted p |");
    lines.push("|---|---|---|---|");
    for (let i = 0; i < exploratoryResults.length; i++) {
      const r = exploratoryResults[i];
      lines.push(`| ${r.id} | ${fmt(r.estimate)} | ${ciStr(r.ci)} | ${fmt(bhAdjusted[i], 4)} |`);
    }
    lines.push("");
  }

  lines.push("## Cost / diversity Pareto frontier");
  lines.push("");
  lines.push("§6.3: not a single 'best model' — the right pick depends on budget. See `out/pareto.svg`.");
  lines.push("");
  lines.push("| Arm | Mean cost (USD) | Mean response | On frontier |");
  lines.push("|---|---|---|---|");
  for (const p of paretoPoints) {
    lines.push(`| ${p.armId} | ${fmt(p.meanCostUsd, 4)} | ${fmt(p.meanResponse)} | ${p.onFrontier ? "yes" : "no"} |`);
  }
  lines.push("");

  lines.push("## Cost lane (descriptive — B6 retires the log(cost)-offset model)");
  lines.push("");
  lines.push("distinct_k / cost ratio per arm, with cluster-bootstrap CIs over briefs. Descriptive only, never a confirmatory contrast.");
  lines.push("");
  lines.push("| Arm | Ratio | 95% CI |");
  lines.push("|---|---|---|");
  for (const [armId, r] of Object.entries(costRatioByArm)) {
    lines.push(`| ${armId} | ${fmt(r.ratio)} | ${ciStr([r.ciLower, r.ciUpper])} |`);
  }
  lines.push("");

  lines.push("## Failures and skips (§6.3 — never silently dropped)");
  lines.push("");
  lines.push("| Arm | Failed (by kind) | Skipped |");
  lines.push("|---|---|---|");
  const arms = new Set([...Object.keys(frame.failuresByArm), ...Object.keys(frame.skippedByArm)]);
  for (const armId of arms) {
    const kinds = frame.failuresByArm[armId] || {};
    const kindsStr = Object.entries(kinds).map(([k, c]) => `${k}: ${c}`).join(", ") || "none";
    lines.push(`| ${armId} | ${kindsStr} | ${frame.skippedByArm[armId] || 0} |`);
  }
  if (frame.excluded.stale.length) {
    lines.push("");
    lines.push(`${frame.excluded.stale.length} stale cell(s) excluded (stored under a different configHash) — never pooled.`);
  }
  lines.push("");

  return lines.join("\n");
}
