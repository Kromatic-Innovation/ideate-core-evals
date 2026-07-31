// control-texts.mjs — the frozen text inputs for every hermetic negative
// control and the DAT replication check (issue #3).
//
// ── Why this file exists separately from regen-fixtures.mjs ────────────────
// The regeneration script (../regen-fixtures.mjs) needs the exact list of
// texts to embed; the tests need the exact same list to look results up by.
// Splitting the TEXT (this file, zero dependencies, safe for tests to import)
// from the EMBEDDING PRODUCTION (regen-fixtures.mjs, imports
// @huggingface/transformers) is what lets tests stay hermetic: a test can
// import DUPLICATE_POOL_TEXT etc. without ever importing the model loader.
//
// Changing any string in this file invalidates ../fixtures/embeddings.json —
// re-run `node evals/metrics/regen-fixtures.mjs` after any edit here. There is
// no hash-gate enforcing that (unlike the corpus's configHash/corpusHash
// mechanism in lib/manifest.mjs) because these are fixed, frozen negative
// controls, not a growing study corpus — a deliberate scope cut, not an
// oversight.

// ── Control 1: duplicate pool ───────────────────────────────────────────────
// 30 copies of ONE idea. Identical text -> identical embedding (the fixture
// embedder looks up by exact string, so this is not merely "very similar",
// it is the SAME vector 30 times). distinct_k must be exactly 1 and pool
// diversity must be exactly 0 — see negative-controls.test.mjs.
export const DUPLICATE_IDEA_TEXT =
  "Launch a subscription box that delivers a curated set of houseplants and care instructions every month.";
export const DUPLICATE_POOL = Array.from({ length: 30 }, () => DUPLICATE_IDEA_TEXT);

// ── Control 2: random-text pool ─────────────────────────────────────────────
// 30 unrelated, topically-scattered sentences (news, recipes, sports, science,
// history, weather...) in the same register (grammatical English, similar
// length) as an idea pool would be, so the control tests semantic spread
// under realistic conditions rather than an easy strawman (e.g. random token
// salad, which would trivially separate and prove nothing about the metric).
//
// Per the issue's pinned comment: do NOT assert these are "near max"
// diversity. Sentence embedders compress on topic/register, so 30 unrelated
// but grammatical English sentences occupy a narrower cone than intuition
// suggests. The actual floor is derived empirically from the DAT replication
// (see dat-replication.test.mjs) and recorded, not assumed here.
export const RANDOM_TEXT_POOL = [
  "The city council voted to extend the downtown bike lane network by six miles.",
  "Add two cups of flour, a pinch of salt, and let the dough rest for an hour.",
  "The visiting team scored twice in the final quarter to force overtime.",
  "Photosynthesis converts light energy into chemical energy stored in glucose.",
  "The treaty was signed in 1648, ending decades of continental conflict.",
  "A cold front moving in from the northwest will drop temperatures overnight.",
  "The museum's new wing houses a collection of pre-Columbian ceramics.",
  "Interest rates were left unchanged following the central bank's meeting.",
  "The hikers reached the summit just before the afternoon clouds rolled in.",
  "A newly discovered exoplanet orbits its star once every nine days.",
  "The orchestra performed a rarely staged symphony to a sold-out hall.",
  "Local beekeepers reported a stronger honey yield than in previous years.",
  "The bridge will be closed for repairs during the first two weeks of March.",
  "Marine biologists tagged a dozen sea turtles off the southern coast.",
  "The novel follows three generations of a family running a coastal inn.",
  "Volunteers cleared debris from the riverbank after the spring flooding.",
  "The startup's new factory will employ roughly four hundred workers.",
  "A total lunar eclipse will be visible across most of the continent.",
  "The chess champion resigned after a surprising sacrifice in the middlegame.",
  "Archaeologists uncovered a mosaic floor beneath the old marketplace.",
  "The airline added a nonstop route connecting the two regional airports.",
  "Farmers rotated their crops this season to help restore soil nitrogen.",
  "The documentary traces the history of a single trade route over centuries.",
  "A software update fixed the battery drain issue reported by users.",
  "The choir rehearsed in the cathedral to test its unusual acoustics.",
  "Researchers linked the coral bleaching event to a prolonged heat wave.",
  "The town's annual harvest festival drew a record number of visitors.",
  "The court's ruling clarified how the zoning ordinance applies to duplexes.",
  "A ferry service will resume between the two islands after years offline.",
  "The potter glazed each bowl by hand before the final kiln firing.",
];

// ── Control 3: shuffled-label control (pre-registration §4.4) ──────────────
// The pre-registration's shuffled-label control is a JUDGE-level check
// ("judging the same pool twice with arm labels permuted yields no score
// difference") — it exists to catch label leakage into an LLM judge. This
// issue (#3) is scoped to POOL-LEVEL metrics (distinct_k, diversity, collapse
// rate) computed directly from embeddings; there is no judge in this module,
// and no arm/model label is ever passed to a metric function here (every
// function below takes only `texts` or `embeddings`, never an arm id).
//
// So the property the control checks for is enforced STRUCTURALLY rather
// than needing its own runtime check: see
// negative-controls.test.mjs "metrics are label-blind by construction",
// which asserts the exported metric functions' signatures carry no
// arm/model/persona parameter, and that permuting an ARBITRARY ordering
// label attached to a pool (independent of the pool's own text/embedding
// order) cannot change distinct_k/diversity/collapse rate, since the
// functions are order-invariant set statistics over the embeddings. The
// judge-level version of this control (with an actual LLM judge and real
// arm labels) is out of scope for #3 and is flagged as follow-up work for
// whichever issue implements evals/judge/.
export const SHUFFLED_LABEL_CONTROL_SCOPE_NOTE =
  "Judge-level shuffled-label control is out of scope for issue #3 (no judge exists yet). " +
  "The pool-metric-level analog (label-blindness / order-invariance) is enforced structurally " +
  "and tested in negative-controls.test.mjs.";

// ── Control 4 / calibration: DAT replication ────────────────────────────────
// Real, published example word groups from Jay Olson's own examples.py in
// jayolson/divergent-association-task (MIT), commit 9978dd8103670a90c59bc35a
// 7210acc60995dcdb (2022-04-22) — "Word examples (Figure 1 in paper)" from
// Olson et al. 2021, PNAS, "Naming unrelated words predicts creativity"
// (https://www.pnas.org/content/118/25/e2022340118).
//
// The repo's own dat.py computes DAT score = mean pairwise cosine distance
// (GloVe 840B.300d vectors) x 100, and its examples.py hardcodes the
// published result of running that computation over these three word groups:
//   low     -> DAT score 50  (low semantic diversity: all body parts)
//   average -> DAT score 78  (everyday objects, no shared category)
//   high    -> DAT score 95  (high semantic diversity: deliberately scattered)
// The published ORDERING low < average < high is the ground truth this
// replication targets. The absolute scores (50/78/95) are GloVe-word-vector
// specific and are NOT expected to reproduce numerically under a different
// embedding model (MiniLM sentence embeddings here) — only the ORDERING is
// the claim we can validate cross-model, and that is exactly the claim
// dat-replication.test.mjs checks. See that file's header for the full
// deviation writeup.
//
// We embed each word standalone (not "cat dog head" concatenated) — same
// unit of embedding dat.py itself uses (per-word GloVe vectors, pairwise
// distance).
export const DAT_LOW = ["arm", "eyes", "feet", "hand", "head", "leg", "body"];
export const DAT_AVERAGE = ["bag", "bee", "burger", "feast", "office", "shoes", "tree"];
export const DAT_HIGH = ["hippo", "jumper", "machinery", "prickle", "tickets", "tomato", "violin"];

export const DAT_SOURCE = {
  repo: "jayolson/divergent-association-task",
  file: "examples.py",
  commitSha: "9978dd8103670a90c59bc35a7210acc60995dcdb",
  commitDate: "2022-04-22",
  license: "MIT",
  paper: "Olson et al. 2021, PNAS, 'Naming unrelated words predicts creativity', https://www.pnas.org/content/118/25/e2022340118",
  publishedDatScores: { low: 50, average: 78, high: 95 },
  note:
    "Published scores computed by dat.py over GloVe 840B.300d vectors. We reuse the WORD " +
    "GROUPS and the ORDERING claim (low < average < high), not the absolute scores, since our " +
    "hermetic embedder is a different model (MiniLM sentence embeddings, not GloVe word vectors).",
};

// ── Calibration set: paraphrase pairs vs. distinct-idea pairs ──────────────
// Used only to DERIVE the clustering distance threshold (../clustering.mjs
// CLUSTER_DISTANCE_THRESHOLD) — never asserted on directly in a control. The
// DAT word groups are excellent for validating ORDERING of semantic distance
// (that's their published purpose) but are all single, mutually-DISTINCT
// words — nothing in DAT is "the same idea restated," so DAT alone cannot
// calibrate a "should these two count as ONE equivalence class" threshold.
// These pairs supply that: each PARAPHRASE_PAIRS entry is the same idea
// reworded (should cluster together / distance should be small); each
// DISTINCT_IDEA_PAIRS entry is two genuinely different ideas in the same
// register/length as the paraphrases (should NOT cluster / distance should
// be larger). The threshold is set where these two populations separate —
// see clustering.mjs "Threshold derivation" for the actual computation.
export const PARAPHRASE_PAIRS = [
  [
    "Launch a subscription box that delivers a curated set of houseplants and care instructions every month.",
    "Start a monthly subscription service that ships customers houseplants along with instructions on how to care for them.",
  ],
  [
    "Build a mobile app that reminds users to drink water throughout the day.",
    "Create a phone application that sends people reminders to stay hydrated during the day.",
  ],
  [
    "Open a neighborhood coffee shop that also hosts live acoustic music on weekends.",
    "Start a local cafe that features live acoustic performances every weekend.",
  ],
  [
    "Design a board game where players negotiate trade routes between fictional cities.",
    "Create a tabletop game in which players bargain over trade routes connecting made-up cities.",
  ],
];

export const DISTINCT_IDEA_PAIRS = [
  [
    "Launch a subscription box that delivers a curated set of houseplants and care instructions every month.",
    "Build a mobile app that reminds users to drink water throughout the day.",
  ],
  [
    "Open a neighborhood coffee shop that also hosts live acoustic music on weekends.",
    "Design a board game where players negotiate trade routes between fictional cities.",
  ],
  [
    "Start a monthly subscription service that ships customers houseplants along with instructions on how to care for them.",
    "Create a phone application that sends people reminders to stay hydrated during the day.",
  ],
  [
    "Create a tabletop game in which players bargain over trade routes connecting made-up cities.",
    "Start a local cafe that features live acoustic performances every weekend.",
  ],
];

// ── Every text that must be present in the committed fixture map ───────────
// Single source of truth for "what does regen-fixtures.mjs need to embed" and
// "what is the hermetic embedder allowed to know about" (fixtureEmbedder.mjs
// throws on any text NOT in this set — see embedder.mjs header). Deduplicated
// because DUPLICATE_POOL repeats one string 30 times and the map only needs
// one entry per distinct string, and PARAPHRASE_PAIRS/DISTINCT_IDEA_PAIRS
// intentionally reuse DUPLICATE_IDEA_TEXT-adjacent strings.
export const ALL_FIXTURE_TEXTS = Array.from(
  new Set([
    ...DUPLICATE_POOL,
    ...RANDOM_TEXT_POOL,
    ...DAT_LOW,
    ...DAT_AVERAGE,
    ...DAT_HIGH,
    ...PARAPHRASE_PAIRS.flat(),
    ...DISTINCT_IDEA_PAIRS.flat(),
  ]),
).sort();
