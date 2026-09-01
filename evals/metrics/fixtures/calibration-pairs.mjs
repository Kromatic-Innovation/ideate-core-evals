// calibration-pairs.mjs — the ≥100-pair labelled calibration set used to
// select CLUSTER_DISTANCE_THRESHOLD in the PRODUCTION embedding space
// (Voyage-4-lite). See issue #42.
//
// ── Provenance: these labels are MODEL-GENERATED, not human ground truth ───
// Every pair below — both the idea text and its same/different label — was
// authored by Claude (claude-sonnet-5, via Claude Code) on 2026-09-01, not
// collected from human raters. This is stated here, in the PR body, and in
// the durable calibration-result record per the issue's explicit requirement
// ("if you generate or label these pairs with a model rather than a human,
// say so explicitly ... do not present model labels as human ground truth").
// A human-labelled replacement/superset is legitimate follow-up work; this
// set exists to give the threshold-selection step SOMETHING better than the
// prior 8 short authored sentences (see fixtures/control-texts.mjs
// PARAPHRASE_PAIRS/DISTINCT_IDEA_PAIRS, which remain in place for the
// hermetic MiniLM-space derivation in calibration.mjs and are unrelated to
// this file).
//
// ── Design: hard negatives, not cross-topic freebies ────────────────────────
// A "different" pair drawn from two unrelated strata (a business idea vs. a
// GPS research idea) would separate trivially and inflate the selected
// threshold — the balanced-accuracy optimizer would happily pick a huge
// threshold that still "correctly" classifies pairs that were never close in
// the first place. That threshold would then fail exactly where it matters:
// telling apart two genuinely different ideas answering the SAME brief in a
// real ~30-item pool, which is what distinct_k actually has to do. So every
// "different" pair here answers the SAME brief (same stratum, same topic,
// matched register and length) — a hard negative, not an easy one. Every
// "same" pair is a paraphrase of one idea answering that brief.
//
// ── Coverage ──────────────────────────────────────────────────────────────
// Drawn from all 12 frozen briefs (evals/corpus/briefs.mjs) across all four
// strata (business, product, scientific, aut), matching that corpus exactly
// (brief text reproduced by id, not re-typed, so this file can't silently
// drift from the corpus it's calibrating against).
//
// Per brief: 4 distinct multi-sentence idea-answers (I1..I4) and 3
// paraphrases (of I1, I2, I3).
//   - "same" pairs: each paraphrase against its source idea — 3 per brief.
//   - "different" pairs: every combination of the 4 base ideas — C(4,2) = 6
//     per brief — covering the full space of pairwise idea-vs-idea
//     comparisons within that brief, not a hand-picked subset.
// 12 briefs × (3 same + 6 different) = 108 pairs.
//
// ── Deviation from real pool structure — stated, not hidden ────────────────
// distinctK's clustering (clustering.mjs clusterByThreshold) uses
// AVERAGE-LINKAGE over a ~30-item pool: a merge decision compares the MEAN
// distance across all cross-cluster pairs, not a single pairwise distance.
// This calibration set only supplies PAIRWISE same/different labels — there
// is no labelled 30-item pool to derive an average-linkage-consistent
// threshold from. The pairwise-optimal threshold is a defensible proxy (it
// is the same quantity PARAPHRASE_PAIRS/DISTINCT_IDEA_PAIRS derives in
// calibration.mjs, just with a different selection rule), not an identical
// one. Flagged here per the issue's own "no hash-gate ... deliberate scope
// cut, not an oversight" convention (see control-texts.mjs) — this is the
// analogous cut for this file.

import { BRIEFS } from "../../corpus/briefs.mjs";

function briefText(id) {
  const b = BRIEFS.find((x) => x.id === id);
  if (!b) throw new Error(`calibration-pairs.mjs: unknown brief id ${id}`);
  return b.text;
}

/**
 * @typedef {object} CalibrationPair
 * @property {string} a
 * @property {string} b
 * @property {"same"|"different"} label
 * @property {"business"|"product"|"scientific"|"aut"} stratum
 * @property {string} briefId
 * @property {"paraphrase"|"distinct-idea-same-brief"} kind
 */

// Per-brief: 4 base ideas (I1..I4) + 3 paraphrases (P1..P3 of I1..I3).
const BRIEF_DATA = {
  "biz-01": {
    stratum: "business",
    ideas: [
      "Cold-email a hand-picked list of decision-makers at companies with the exact pain point the product solves, tying each pitch to something specific about their business.",
      "Publish free tools that partially solve the problem the paid product addresses, capturing the people who try the free tool as it becomes a marketing funnel to paid signups.",
      "Pay to sponsor developer or industry newsletters that the target buyers already read, buying attention in a place they trust.",
      "Recruit a small group of early customers to co-design the product in exchange for founding-member pricing, using their feedback to sharpen the roadmap.",
    ],
    paraphrases: [
      "Reach out directly to a curated list of executives at firms that clearly have the problem being solved, and make every outreach message reference something particular about their situation.",
      "Give away tools that solve part of the same problem the paid product tackles, then turn people who use the free version into a pipeline of paying signups.",
      "Buy ad space in the newsletters the target buyers already subscribe to, so the product gets seen where their attention already goes.",
    ],
  },
  "biz-02": {
    stratum: "business",
    ideas: [
      "Charge a flat monthly fee that's the same for every customer regardless of how much they use the product.",
      "Price per active seat, so cost scales directly with how many people at a company are using the product.",
      "Charge based on usage volume, billing customers only for the amount of the resource they actually consume each month.",
      "Offer one free tier capped at a low usage limit, then charge only once a customer's usage crosses that limit.",
    ],
    paraphrases: [
      "Set a single flat subscription price that stays the same no matter how heavily a customer uses the product.",
      "Bill customers per seat, so the price rises and falls with the number of active users at their company.",
      "Charge customers according to how much of the resource they consume in a given month, rather than a flat rate.",
    ],
  },
  "biz-03": {
    stratum: "business",
    ideas: [
      "Survey the company's existing customers about which other regions they operate in, and expand into whichever region shows up most.",
      "Run small paid ad campaigns in a handful of candidate markets and expand into whichever one generates the cheapest qualified leads.",
      "Study competitors' geographic footprints and expand into a market a close competitor has left underserved.",
      "Interview the sales team about which regions prospects keep asking whether the company serves, and expand into the most-requested one.",
    ],
    paraphrases: [
      "Ask current customers which other regions their own operations span, then pick the region that comes up most often to expand into.",
      "Test a few candidate markets with small paid ad campaigns and choose whichever one produces the lowest-cost qualified leads to expand into.",
      "Look at where a close competitor operates and target a region that competitor has largely left unserved.",
    ],
  },
  "biz-04": {
    stratum: "business",
    ideas: [
      "Interview a sample of customers who cancelled recently and ask them directly what stopped them from staying.",
      "Compare product usage data between customers who stayed and customers who cancelled to find the behavior pattern that predicts churn.",
      "Add a proactive check-in from a support rep partway through the trial period, before the point where most cancellations happen.",
      "Redesign the onboarding flow so customers reach the product's core value faster, on the theory that slow time-to-value is driving the cancellations.",
    ],
    paraphrases: [
      "Talk to a group of customers who recently cancelled and ask them plainly what caused them to leave.",
      "Look at the difference in product usage between customers who stuck around and ones who cancelled, to spot the pattern that predicts who churns.",
      "Have a support rep reach out proactively partway through the trial, before most cancellations tend to happen.",
    ],
  },
  "prod-01": {
    stratum: "product",
    ideas: [
      "Let users export their data as a single downloadable CSV file they can open in a spreadsheet.",
      "Build a scheduled export that automatically emails a report file to the user on a recurring basis.",
      "Add a direct export-to-integration path that sends the data straight into another tool the user already connects, like a spreadsheet service or a CRM.",
      "Expose an API endpoint so users' own scripts can pull the data out programmatically whenever they want.",
    ],
    paraphrases: [
      "Give users a way to download all their data as one CSV file that opens cleanly in a spreadsheet program.",
      "Set up a recurring scheduled export that emails the user a report file automatically at a set interval.",
      "Add a direct hand-off from the export feature into another tool the user already has connected, such as a spreadsheet service or CRM.",
    ],
  },
  "prod-02": {
    stratum: "product",
    ideas: [
      "Show a short interactive walkthrough on first launch that has the user actually perform the app's core action once.",
      "Skip any tutorial and instead pre-fill the user's first session with realistic sample content so they see the core feature already working.",
      "Ask the user two or three quick setup questions and use the answers to configure the core feature for their specific situation before they even start.",
      "Send a short guided email series over the user's first few days, each one nudging them to try one part of the core feature.",
    ],
    paraphrases: [
      "On first launch, show a brief interactive walkthrough that has the user actually do the app's core action themselves, once.",
      "Instead of a tutorial, pre-populate the user's first session with realistic sample content so the core feature already looks like it's working.",
      "Have the user answer two or three fast setup questions, then use those answers to configure the core feature for their situation before they begin.",
    ],
  },
  "prod-03": {
    stratum: "product",
    ideas: [
      "Add a keyboard-shortcut cheat sheet so power users can navigate the product without reaching for the mouse.",
      "Add a dark-mode theme toggle so users can switch the interface to a low-light color scheme.",
      "Add a bulk-edit action that lets a user change one field across many records at once, instead of one at a time.",
      "Add an undo button for the single most common destructive action in the product.",
    ],
    paraphrases: [
      "Ship a cheat sheet of keyboard shortcuts so heavy users can move through the product without touching the mouse.",
      "Add a toggle that switches the whole interface into a dark, low-light color scheme.",
      "Add a bulk-edit feature that applies a single field change across many records at once, rather than editing them individually.",
    ],
  },
  "sci-01": {
    stratum: "scientific",
    ideas: [
      "Study how intercropping two complementary plant species affects yield compared to growing either species alone.",
      "Test whether a particular soil microbe additive measurably increases nitrogen uptake in a staple grain crop.",
      "Measure how drought-stress timing during a crop's growth cycle changes its final yield, to identify the most vulnerable growth stage.",
      "Compare crop yield under drip irrigation versus overhead sprinkler irrigation across a range of soil types.",
    ],
    paraphrases: [
      "Investigate how planting two complementary crop species together, rather than each alone, changes total yield.",
      "Test whether adding a specific soil microbe boosts nitrogen uptake in a staple grain crop.",
      "Measure how the timing of drought stress across a crop's growth cycle affects its eventual yield, to find the growth stage most vulnerable to water loss.",
    ],
  },
  "sci-02": {
    stratum: "scientific",
    ideas: [
      "Investigate how urban high-rise clustering degrades GPS positioning accuracy and whether a correction model can compensate.",
      "Study how combining GPS with inertial sensors improves position accuracy during brief satellite-signal outages, such as inside tunnels.",
      "Measure how solar activity affects the accuracy of civilian GPS signals over the course of a solar cycle.",
      "Test whether a low-cost ground reference station network can improve GPS accuracy for agricultural equipment in a given region.",
    ],
    paraphrases: [
      "Study how clusters of tall buildings in cities degrade GPS accuracy, and whether a correction model can offset the effect.",
      "Investigate how pairing GPS with inertial sensors keeps position accuracy up during short satellite-signal losses, like inside a tunnel.",
      "Measure how solar activity across a solar cycle affects the accuracy of civilian-grade GPS signals.",
    ],
  },
  "sci-03": {
    stratum: "scientific",
    ideas: [
      "Measure how different livestock feed additives change the volume of methane cattle emit.",
      "Study how wetland restoration changes the balance between carbon sequestration and methane release from a given site.",
      "Test whether a specific soil amendment reduces nitrous oxide emissions from fertilized cropland.",
      "Model how urban tree-canopy expansion affects a city's net carbon dioxide balance over a decade.",
    ],
    paraphrases: [
      "Test how different feed additives given to cattle change the amount of methane they emit.",
      "Investigate how restoring a wetland shifts the balance between how much carbon it stores and how much methane it releases.",
      "Measure whether a particular soil amendment cuts nitrous oxide emissions from cropland that's been fertilized.",
    ],
  },
  "aut-01": {
    stratum: "aut",
    ideas: [
      "Use it as a doorstop to keep a heavy door from swinging shut.",
      "Grind it down and use the dust as a red pigment for paint or dye.",
      "Stack several to build a small raised platform for a plant pot.",
      "Use it as a weight to hold down a tarp in the wind.",
    ],
    paraphrases: [
      "Wedge it against a door so it can't swing closed on its own.",
      "Crush it into powder and use the resulting dust as a reddish pigment.",
      "Stack a few of them to build a short raised stand for a potted plant.",
    ],
  },
  "aut-02": {
    stratum: "aut",
    ideas: [
      "Bend it straight and use it as a makeshift SIM-card eject tool for a phone.",
      "Use it to clean out the small drain holes in a plant pot.",
      "Bend it into a small hook to fish something out of a narrow gap.",
      "Use it as an improvised zipper pull when the original tab breaks off.",
    ],
    paraphrases: [
      "Straighten it out and use it in place of a phone's SIM-eject pin.",
      "Use it to poke out and clear the small drainage holes on the bottom of a plant pot.",
      "Bend it into a tiny hook shape to retrieve something stuck in a narrow gap.",
    ],
  },
};

/** @type {CalibrationPair[]} */
export const CALIBRATION_PAIRS = [];

for (const [briefId, data] of Object.entries(BRIEF_DATA)) {
  // Referenced so this file fails loudly if the corpus changes underneath it.
  briefText(briefId);
  const { stratum, ideas, paraphrases } = data;

  // "same" pairs: each paraphrase against the idea it restates (I1/P1, I2/P2, I3/P3).
  paraphrases.forEach((p, i) => {
    CALIBRATION_PAIRS.push({ a: ideas[i], b: p, label: "same", stratum, briefId, kind: "paraphrase" });
  });

  // "different" pairs: every combination of the 4 base ideas — hard
  // negatives, same brief/stratum/register.
  for (let i = 0; i < ideas.length; i++) {
    for (let j = i + 1; j < ideas.length; j++) {
      CALIBRATION_PAIRS.push({
        a: ideas[i],
        b: ideas[j],
        label: "different",
        stratum,
        briefId,
        kind: "distinct-idea-same-brief",
      });
    }
  }
}

export const CALIBRATION_PAIR_COUNT = CALIBRATION_PAIRS.length;
export const CALIBRATION_SET_PROVENANCE = {
  labelledBy: "model",
  model: "claude-sonnet-5 (Claude Code)",
  date: "2026-09-01",
  note:
    "Every pair (text and same/different label) was authored by an LLM, not collected from human " +
    "raters. Presented here as model-generated calibration data, not human ground truth. See issue #42.",
};
