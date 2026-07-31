// config.mjs — the ρ floor is read from config, never baked in (issue #4, AC9).
//
// ── Why there is no default number here ─────────────────────────────────────
// docs/PREREGISTRATION.md §5.1 pins the floor to "the human-human inter-rater
// agreement Si et al. themselves report — confirm their reported figure and
// set the floor to it, rather than to a number we like." The doc's own
// ρ ≥ 0.4 is explicitly flagged as an unconfirmed placeholder pending that
// confirmation. The issue's own re-scope comment is explicit: "The ρ floor
// constant... still human-only... #4 now *reads* the floor from config and
// **errors if it is unset**; it does not choose a number." Baking in ANY
// number here — even 0.4 — would silently promote a placeholder into a de
// facto default the moment nobody reads the doc closely; the only way to
// guarantee that can't happen is for the absence of an explicit floor to be a
// hard error, not a silently-applied fallback.
//
// A human registers the floor once Si et al.'s reported inter-rater figure is
// confirmed, by supplying `config.judge.rhoFloor` at the call site (e.g. from
// a future study-config file) — this module never writes that value itself,
// and arms.config.json is deliberately NOT touched by this issue to add one.

/**
 * Read the ρ floor from a config object. Throws if it is absent or not a
 * finite number — there is no default, per the header above.
 *
 * @param {object} config  arbitrary config object; the floor is read from
 *   `config.judge.rhoFloor` if present.
 * @returns {number} the registered ρ floor
 */
export function resolveRhoFloor(config) {
  const rhoFloor = config && config.judge ? config.judge.rhoFloor : undefined;
  if (typeof rhoFloor !== "number" || !Number.isFinite(rhoFloor)) {
    throw new Error(
      "resolveRhoFloor: no rho floor is registered (config.judge.rhoFloor is unset). " +
        "This is not a default-able value — docs/PREREGISTRATION.md §5.1 requires it be pinned to " +
        "Si et al.'s reported human-human inter-rater agreement by a human, not assumed by code. " +
        "Register it explicitly before validating a judge.",
    );
  }
  return rhoFloor;
}
