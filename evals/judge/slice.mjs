// slice.mjs — read the Si et al. 2024 expert-score validation slice from the
// gitignored `data/si-et-al/` tree, join idea files to their expert reviews,
// and hand the judge idea TEXT ONLY (issue #24).
//
// ── Fails loud, never falls back (#24) ──────────────────────────────────────
// The slice is fetched locally and NEVER redistributed in this repo
// (.gitignore: data/si-et-al/; provenance: docs/fetching-si-et-al.md). So in
// any hermetic context — CI, a fresh checkout — the slice is ABSENT. This
// reader THROWS loudly when the slice is missing rather than falling back to a
// fixture or emitting a verdict computed on stand-in data. A verdict must be
// computed on the real held-out expert scores or not at all. (Hermetic tests
// exercise this reader against a SYNTHETIC fixture of the same shape, passed via
// an explicit `root` — they never touch the real slice.)
//
// ── The join is by (directory, filename), not filename alone (#24) ──────────
// The three condition directories carry COLLIDING filenames: e.g. both
// AI_AI_Ideas_Processed/ and AI_Human_Ideas_Txt/ contain
// `adaptive_confidence-guided_prompting.txt`. The directory is the only thing
// distinguishing AI from AI_Rerank, so the join key is (directory, filename),
// and the directory determines the condition.
//
// The human-condition files are NOT named by title (they are
// `HumanIdeaForm_<name>.txt`, `IdeaGeneration_<name>.txt`, …), so the human
// join runs: read the file's `Title:` first line -> normalize -> match against
// id_title_mapping.csv -> idea_id -> reviews. The AI/AI_Rerank files ARE named
// by a slugified title; they still resolve through the same normalized-title
// lookup (their `Title:` line, falling back to the filename slug).
//
// ── Totality is asserted, not hoped (#24) ───────────────────────────────────
// A silently partial join would quietly shrink the validation slice and change
// the accuracy — the same silent-truncation class `reconcile()` guards against
// elsewhere. So this reader asserts BOTH directions: every idea file resolves
// to an idea_id, and every idea_id present in the reviews resolves to exactly
// one idea file. Any residue THROWS with the specifics.
//
// ── One carve-out: an explicitly EXCLUDED condition (#35) ───────────────────
// A whole condition may be dropped by NAMED configuration (DEFAULT_EXCLUDED_
// CONDITIONS = ["AI_Rerank"], because 31 of its 49 idea_ids cannot be recovered
// from the released mapping). An excluded condition is skipped whole — its
// directory is not read and its review idea_ids are removed from BOTH totality
// checks — and the exclusion, with its reason, is RETURNED (`exclusions`) so it
// reaches the validation record and REPORT.md. This is the only place the
// fail-closed contract yields: an unresolved file in an INCLUDED condition
// still throws. Exclusion is not a general "drop what doesn't join" path.
// A single stubborn near-miss inside an included condition is resolved by a
// HAND_RESOLVED_IDEA_IDS override (`<dir>/<filename>` -> idea_id), validated
// against the reviews so a mistyped override throws.
//
// ── Two leakage hazards, closed here (#24, PREREGISTRATION §5.3) ─────────────
// 1. The filename format reveals the condition (human vs AI) before a word is
//    read. 2. Human idea-writers' first names are in the human filenames.
// Neither may reach the judge. So: this reader returns idea `text` (file
// contents, spot-checked clean of names) plus the condition on the HARNESS
// side; `sliceToJudgePool()` yields TEXT-ONLY judge inputs, and no path,
// filename, directory name, or condition label is ever part of a judge payload,
// the store, a log, or REPORT.md. Condition is joined back only AFTER scoring.

import fs from "node:fs";
import path from "node:path";

/** Directory -> condition. The directory is the sole condition signal, and the
 *  key that disambiguates the AI/AI_Rerank filename collision. */
export const CONDITION_DIRS = Object.freeze({
  Human_Ideas_Txt_Processed: "Human",
  AI_AI_Ideas_Processed: "AI",
  AI_Human_Ideas_Txt: "AI_Rerank",
});

/** Default expert score column read from the reviews (the overall quality
 *  score; per-axis columns exist too — see docs/fetching-si-et-al.md). */
export const DEFAULT_SCORE_FIELD = "overall_score";

/**
 * Conditions excluded from judge validation by EXPLICIT, NAMED configuration
 * (issue #35). An excluded condition's directory is skipped whole and its
 * review idea_ids are dropped from the totality assertions — but this is the
 * ONLY escape hatch: an unresolved file in an *included* condition still throws
 * (the fail-closed contract survives; the exclusion is not a general
 * "drop what doesn't join" path). The exclusion, and its reason, are returned
 * in the read result so they reach the validation record and REPORT.md rather
 * than being swallowed silently.
 */
export const DEFAULT_EXCLUDED_CONDITIONS = Object.freeze(["AI_Rerank"]);

/** Why each excludable condition is excluded — recorded so the exclusion is
 *  self-describing downstream (a validation record / REPORT.md reads this). */
export const CONDITION_EXCLUSION_REASONS = Object.freeze({
  AI_Rerank:
    "AI_Rerank excluded from judge validation (operator decision, issue #35, 2026-08-02). " +
    "Of its 49 files, only 18 share a filename with the AI condition and are suffix-swap recoverable; " +
    "the other 31 draw from a larger generated pool than the AI condition's 49 sampled ideas and their " +
    "idea_id cannot be recovered from the released id_title_mapping.csv at all. Including only the " +
    "recoverable 18 would represent the condition by a non-random 37% subsample. Validation needs a " +
    "reliable expert-scored set, not a complete one — Human + AI (98 ideas) is sufficient.",
});

/**
 * Hand-resolved (`<directory>/<filename>` → idea_id) overrides for genuine
 * near-misses whose `Title:` line and filename stem do not normalize to any
 * mapping value — the "resolve by hand and record it" path this reader has
 * always promised (#24). Empty by default: an override binds an idea file
 * DIRECTLY to a review idea_id, bypassing the title lookup, so it must be added
 * deliberately by an operator looking at the real slice, with the reason
 * recorded in docs/fetching-si-et-al.md "Hand-resolved near-misses".
 *
 * The known straggler is `Human_Ideas_Txt_Processed/IdeaGeneration_Soham.txt`
 * (issue #35). The extension-normalization below (stripMappingExtension) will
 * resolve it automatically IF its mapping value is a filename; if the real-slice
 * run shows it still unresolved, the operator adds one entry here, e.g.
 *   "Human_Ideas_Txt_Processed/IdeaGeneration_Soham.txt": "<its idea_id>",
 * The reader validates that the bound idea_id exists in the reviews under the
 * SAME condition as the directory, so a mistyped override throws rather than
 * silently binding an idea to the wrong expert scores.
 */
export const HAND_RESOLVED_IDEA_IDS = Object.freeze({});

/**
 * Normalize a title for joining: lowercase, strip surrounding whitespace,
 * collapse internal whitespace, and drop punctuation. Enough to bridge a
 * slugified filename and a human-typed `Title:` line; a residue of genuine
 * near-misses is expected to resolve by hand and be recorded in
 * docs/fetching-si-et-al.md (#24). Deliberately conservative — over-normalizing
 * risks collapsing two distinct titles into one, which the totality assertion
 * would then surface as a collision rather than hide.
 */
export function normalizeTitle(s) {
  return String(s)
    .toLowerCase()
    .replace(/[‐-―]/g, "-") // unicode dashes -> hyphen
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Normalize an `idea_id` from the reviews JSON by stripping ALL whitespace
 * (issue #37). Five of the 147 released `idea_id` values carry a stray
 * internal space before the condition suffix (e.g. `"Multilingual_9 _Human"`
 * instead of `"Multilingual_9_Human"`), and a sixth (`"Bias_1 _AI_Rerank"`)
 * falls in the excluded AI_Rerank condition. `id_title_mapping.csv` contains
 * zero such ids, so an un-normalized key lookup (`byIdea.get(csvId)`) silently
 * misses these five, dropping them out of `titleIndex` and starving their idea
 * files of a match. Stripping whitespace (rather than just trimming) closes
 * the gap without any hand-resolution. Verified against the real payload to
 * merge no distinct ids: 147 raw idea_ids normalize to 147 unique, and the 98
 * CSV ids (Human + AI) normalize to 98 unique — no collision.
 */
export function normalizeIdeaId(id) {
  return typeof id === "string" ? id.replace(/\s+/g, "") : id;
}

/**
 * Strip a trailing `.json`/`.txt` filename extension and surrounding whitespace
 * from a mapping value before it is normalized (issue #35). The mapping's
 * `ID,Title / Filename` column is a prose title for Human rows but a FILENAME
 * for the AI conditions — e.g. `'temporal_bias_decay_simulation.json '`, a
 * `.json` extension with a trailing space, not a title. Stripping the extension
 * (and trimming the stray space) lets a filename-style value normalize to the
 * same token stream as the idea file's `.txt` stem, so it joins. A genuine prose
 * title is left untouched (idea titles do not end in `.json`/`.txt`). Only these
 * two known extensions are stripped, deliberately — a broader `\.\w+$` risks
 * clipping a real title.
 */
export function stripMappingExtension(value) {
  return String(value).trim().replace(/\.(?:json|txt)$/i, "").trim();
}

/** Parse a single CSV line into fields, honoring double-quoted fields (titles
 *  may contain commas). Minimal — the mapping file is `ID,Title` two-column. */
function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur); cur = "";
    } else cur += ch;
  }
  fields.push(cur);
  return fields;
}

/** Read id_title_mapping.csv -> Map<idea_id, title>. First row is treated as a
 *  header iff its first field is not itself an id present in the data (we simply
 *  skip a leading row whose second column looks like the literal "Title"). */
function readIdTitleMapping(csvPath) {
  const raw = fs.readFileSync(csvPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const map = new Map();
  for (let i = 0; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 2) continue;
    const id = fields[0].trim();
    const title = fields[1].trim();
    if (i === 0 && /^title$/i.test(title) && /^id$/i.test(id)) continue; // header row
    if (!id) continue;
    map.set(id, title);
  }
  return map;
}

/**
 * Read the column-oriented reviews JSON (a dict of equal-length arrays) and
 * group per idea_id: condition + the expert score of each review of that idea.
 * `idea_id` is run through `normalizeIdeaId` (whitespace-stripped) as it is
 * keyed, so a stray-space id (issue #37) still binds to its clean CSV
 * counterpart.
 * @returns {{ byIdea: Map<string, {condition: string, scores: number[]}>, reviewCount: number }}
 */
function readReviews(jsonPath, scoreField) {
  const cols = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const ideaIds = cols.idea_id;
  const conditions = cols.condition;
  const scores = cols[scoreField];
  if (!Array.isArray(ideaIds) || !Array.isArray(scores)) {
    throw new Error(
      `readReviews: ${jsonPath} is not the expected column-oriented shape ` +
        `(missing idea_id or ${scoreField} array)`,
    );
  }
  const n = ideaIds.length;
  const byIdea = new Map();
  for (let i = 0; i < n; i++) {
    const id = normalizeIdeaId(ideaIds[i]);
    const score = scores[i];
    const condition = Array.isArray(conditions) ? conditions[i] : undefined;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new Error(`readReviews: non-numeric ${scoreField} at review index ${i} (idea_id=${id})`);
    }
    let entry = byIdea.get(id);
    if (!entry) { entry = { condition, scores: [] }; byIdea.set(id, entry); }
    else if (condition !== undefined && entry.condition !== undefined && entry.condition !== condition) {
      throw new Error(`readReviews: idea_id ${id} appears under conflicting conditions ${entry.condition} and ${condition}`);
    }
    entry.scores.push(score);
  }
  return { byIdea, reviewCount: n };
}

/** Extract the `Title:` first line of an idea file, or null if absent. */
function readTitleLine(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const m = firstLine.match(/^\s*Title:\s*(.+?)\s*$/i);
  return m ? m[1] : null;
}

/**
 * Read and join the whole Si et al. slice.
 *
 * @param {object} o
 *   @param {string} o.root         path to the slice root (default data/si-et-al)
 *   @param {string} [o.scoreField] reviews column to read as the expert score
 *   @param {string[]} [o.excludedConditions] conditions excluded by explicit,
 *     named configuration (default DEFAULT_EXCLUDED_CONDITIONS = ["AI_Rerank"]).
 *     Their directory is skipped whole and their review idea_ids are dropped
 *     from BOTH totality assertions. Everything NOT listed here is fail-closed:
 *     an unresolved file in an included condition still throws.
 *   @param {Object<string,string>} [o.handResolved] `<dir>/<filename>` → idea_id
 *     overrides for hand-resolved near-misses (default HAND_RESOLVED_IDEA_IDS).
 * @returns {{ ideas: Array<{ideaId: string, condition: string, text: string, expertScores: number[]}>,
 *             reviewCount: number, ideaCount: number, nearMisses: Array,
 *             exclusions: Array<{condition: string, dir: string, reason: string, fileCount: number}> }}
 *   Note: NO filename/path is returned — only ideaId, condition (harness-side),
 *   text, and expertScores. Callers must still route text through
 *   sliceToJudgePool() before the judge sees it. `exclusions` records every
 *   condition dropped by configuration (with its reason) so the exclusion is
 *   visible downstream in the validation record and REPORT.md.
 */
export function readSiEtAlSlice({
  root = path.join("data", "si-et-al"),
  scoreField = DEFAULT_SCORE_FIELD,
  excludedConditions = DEFAULT_EXCLUDED_CONDITIONS,
  handResolved = HAND_RESOLVED_IDEA_IDS,
} = {}) {
  const excludedSet = new Set(excludedConditions);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(
      `readSiEtAlSlice: the Si et al. expert-score slice is not present at '${root}'. ` +
        "This slice is fetched locally and never committed (.gitignore: data/si-et-al/; see " +
        "docs/fetching-si-et-al.md). Refusing to fall back to a fixture or emit a verdict on stand-in data — " +
        "fetch the slice (#16) before running the real validation.",
    );
  }
  const csvPath = path.join(root, "id_title_mapping.csv");
  const jsonPath = path.join(root, "data_points_all_anonymized.json");
  for (const p of [csvPath, jsonPath]) {
    if (!fs.existsSync(p)) {
      throw new Error(`readSiEtAlSlice: required slice file missing: '${p}'. The slice at '${root}' is incomplete.`);
    }
  }

  const idToTitle = readIdTitleMapping(csvPath);
  const { byIdea, reviewCount } = readReviews(jsonPath, scoreField);

  // Build per-condition normalized-title -> idea_id, using the reviews' own
  // condition for each id. An idea_id in the CSV with no reviews (or vice
  // versa) is caught by the totality assertion below.
  const titleIndex = new Map(); // condition -> Map<normalizedTitle, ideaId>
  for (const [id, title] of idToTitle) {
    const entry = byIdea.get(id);
    const condition = entry ? entry.condition : undefined;
    if (condition === undefined) continue; // no reviews for this id — totality check reports it
    if (excludedSet.has(condition)) continue; // excluded by config — do not index
    if (!titleIndex.has(condition)) titleIndex.set(condition, new Map());
    // Strip a filename-style extension (`.json`/`.txt`, + stray whitespace)
    // before normalizing, so the AI conditions' `<slug>.json ` mapping values
    // join against the idea file's `.txt` stem (issue #35).
    const norm = normalizeTitle(stripMappingExtension(title));
    const perCond = titleIndex.get(condition);
    if (perCond.has(norm) && perCond.get(norm) !== id) {
      throw new Error(
        `readSiEtAlSlice: normalized title collision under condition '${condition}': ` +
          `'${title}' (norm '${norm}') maps to both ${perCond.get(norm)} and ${id}`,
      );
    }
    perCond.set(norm, id);
  }

  const ideas = [];
  const boundIdeaIds = new Set();
  const nearMisses = [];
  const exclusions = [];
  for (const [dir, condition] of Object.entries(CONDITION_DIRS)) {
    const dirPath = path.join(root, dir);
    // An excluded condition is skipped WHOLE — not read, not near-missed. The
    // exclusion and its reason are recorded so they reach the validation record
    // and REPORT.md rather than being swallowed silently (issue #35). This is
    // the only place the fail-closed contract yields, and only for a condition
    // named in `excludedConditions` — never a per-file "drop what doesn't join".
    if (excludedSet.has(condition)) {
      const fileCount = fs.existsSync(dirPath)
        ? fs.readdirSync(dirPath).filter((f) => f.endsWith(".txt")).length
        : 0;
      exclusions.push({
        condition,
        dir,
        reason:
          CONDITION_EXCLUSION_REASONS[condition] ||
          `Condition '${condition}' excluded by explicit configuration (no reason registered).`,
        fileCount,
      });
      continue;
    }
    if (!fs.existsSync(dirPath)) {
      throw new Error(`readSiEtAlSlice: condition directory missing: '${dirPath}' (expected condition '${condition}').`);
    }
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".txt")).sort();
    const perCond = titleIndex.get(condition) || new Map();
    for (const filename of files) {
      const text = fs.readFileSync(path.join(dirPath, filename), "utf8");
      const titleFromLine = readTitleLine(text);
      let ideaId = null;

      // 1. Hand-resolved override (`<dir>/<filename>` -> idea_id) wins: the
      //    promised "resolve by hand and record it" path for a genuine
      //    near-miss (#24/#35). Validated against the reviews so a mistyped
      //    override throws instead of binding an idea to the wrong scores.
      const overrideKey = `${dir}/${filename}`;
      if (Object.prototype.hasOwnProperty.call(handResolved, overrideKey)) {
        const overrideId = handResolved[overrideKey];
        const overrideEntry = byIdea.get(overrideId);
        if (!overrideEntry) {
          throw new Error(
            `readSiEtAlSlice: hand-resolved override '${overrideKey}' -> '${overrideId}' names an idea_id ` +
              "not present in the reviews. Fix the override in HAND_RESOLVED_IDEA_IDS.",
          );
        }
        if (overrideEntry.condition !== undefined && overrideEntry.condition !== condition) {
          throw new Error(
            `readSiEtAlSlice: hand-resolved override '${overrideKey}' -> '${overrideId}' binds a file in ` +
              `condition '${condition}' to a review under condition '${overrideEntry.condition}'.`,
          );
        }
        ideaId = overrideId;
      }

      // 2. Otherwise the normalized-title lookup: the file's own Title: line,
      //    then the filename slug (the AI conditions are named by slugified
      //    title).
      if (!ideaId) {
        const titleFromName = filename.replace(/\.txt$/i, "");
        for (const candidate of [titleFromLine, titleFromName]) {
          if (!candidate) continue;
          const hit = perCond.get(normalizeTitle(candidate));
          if (hit) { ideaId = hit; break; }
        }
      }

      if (!ideaId) {
        // Record as a near-miss for hand resolution rather than silently
        // dropping — the totality assertion below turns any residue into a throw.
        nearMisses.push({ condition, dir, filename, titleFromLine, resolved: false });
        continue;
      }
      if (boundIdeaIds.has(ideaId)) {
        throw new Error(
          `readSiEtAlSlice: idea_id '${ideaId}' resolved from more than one file (condition '${condition}', file '${filename}') — ` +
            "the (directory, filename) join must be one-to-one.",
        );
      }
      boundIdeaIds.add(ideaId);
      ideas.push({ ideaId, condition, text, expertScores: byIdea.get(ideaId).scores });
    }
  }

  // Totality, both directions.
  if (nearMisses.length > 0) {
    throw new Error(
      `readSiEtAlSlice: ${nearMisses.length} idea file(s) did not resolve to an idea_id — the join is not total. ` +
        "Resolve these by hand and record them in docs/fetching-si-et-al.md, or fix normalization. Unresolved: " +
        nearMisses.map((m) => `${m.dir}/${m.filename}`).join(", "),
    );
  }
  // Reverse totality is asserted only over INCLUDED conditions: an excluded
  // condition's review idea_ids have no idea file by design, and must not be
  // counted as an unresolved residue (issue #35). An idea_id whose condition is
  // UNKNOWN (undefined — e.g. a review that lost its condition label) is
  // deliberately NOT dropped: it stays in the assertion and must resolve to a
  // file or throw. Only an explicitly-excluded condition is dropped; nothing
  // else silently shrinks the slice.
  const reviewIdeaIds = [...byIdea.keys()].filter((id) => {
    const cond = byIdea.get(id).condition;
    return cond === undefined || !excludedSet.has(cond);
  });
  const unresolvedReviewIds = reviewIdeaIds.filter((id) => !boundIdeaIds.has(id));
  if (unresolvedReviewIds.length > 0) {
    throw new Error(
      `readSiEtAlSlice: ${unresolvedReviewIds.length} idea_id(s) in the reviews resolved to no idea file — ` +
        "the join is not total (a partial join would silently shrink the validation slice). Unresolved idea_ids: " +
        unresolvedReviewIds.join(", "),
    );
  }

  return { ideas, reviewCount, ideaCount: ideas.length, nearMisses, exclusions };
}

/**
 * Reduce a read slice to TEXT-ONLY judge inputs — the single boundary the judge
 * payload crosses. No ideaId, condition, filename, path, or directory survives.
 * Route slice ideas through this before assembling any judge payload
 * (deidentify.mjs's deidentifyPool then re-asserts text-only at the pool
 * choke point).
 *
 * @param {{ideas: Array<{text: string}>}} slice
 * @returns {Array<{text: string}>}
 */
export function sliceToJudgePool(slice) {
  if (!slice || !Array.isArray(slice.ideas)) {
    throw new Error("sliceToJudgePool: expected a read slice with an `ideas` array");
  }
  return slice.ideas.map((idea) => {
    if (typeof idea.text !== "string" || idea.text.length === 0) {
      throw new Error("sliceToJudgePool: every slice idea must carry non-empty text");
    }
    return { text: idea.text };
  });
}
