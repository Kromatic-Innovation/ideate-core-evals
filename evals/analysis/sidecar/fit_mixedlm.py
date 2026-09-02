#!/usr/bin/env python3
"""fit_mixedlm.py -- the ENTIRE Python surface of evals/analysis/ (issue #46).

Reads ONE JSON object from stdin, fits R0 or R1 with statsmodels' MixedLM,
and prints ONE JSON object to stdout: coefficients, the full vcov matrix,
coefficientNames (echoed back so Node can verify alignment, never assumed
positional), convergence + variance-component diagnostics, n, and the
toolchain versions actually running. Nothing else -- no p-values, no CIs, no
contrasts. Every piece of registered inferential logic beyond "fit this
formula and hand back the linear-model primitives" lives in Node
(evals/analysis/fit.mjs, contrasts.mjs) so it runs inside `node --test`.

stdin schema:
  {
    "rung": "R0" | "R1",
    "rows": [{"arm": "<armId>", "brief": "<briefId>", "y": <number>}, ...],
    "armLevels": ["A", "B", ...],       # full, pinned level order
    "referenceArm": "A"
  }

stdout schema (exactly one JSON object, nothing else on stdout -- diagnostics
and warnings go to stderr):
  {
    "converged": bool,
    "coefficients": [number, ...],       # aligned to coefficientNames
    "coefficientNames": ["Intercept", "arm[T.B]", ...],
    "vcov": [[number, ...], ...],        # full covariance matrix, same order
    "varianceComponents": {"brief": number, "brief:arm": number?},
    "n": int,
    "toolchain": {"python": "...", "numpy": "...", "scipy": "...",
                  "pandas": "...", "statsmodels": "..."}
  }

Exit code is non-zero on ANY fit exception, with a message on stderr --
Node's fit.mjs treats that (plus a missing venv, or a schema-invalid
response) as a hard failure: no numbers, never a silent fallback.
"""
import json
import sys


def toolchain_versions():
    import numpy
    import scipy
    import pandas
    import statsmodels

    return {
        "python": sys.version.split()[0],
        "numpy": numpy.__version__,
        "scipy": scipy.__version__,
        "pandas": pandas.__version__,
        "statsmodels": statsmodels.__version__,
    }


def expected_coefficient_names(arm_levels, reference_arm):
    if reference_arm not in arm_levels:
        raise ValueError(f"referenceArm '{reference_arm}' not in armLevels {arm_levels}")
    others = [a for a in arm_levels if a != reference_arm]
    return ["Intercept"] + [f"arm[T.{a}]" for a in others]


def fit(request):
    import numpy as np
    import pandas as pd
    import statsmodels.formula.api as smf

    rung = request["rung"]
    if rung not in ("R0", "R1"):
        raise ValueError(f"fit_mixedlm.py only fits R0/R1 (R2 is pure-Node CR2, R3 is descriptive-only) -- got '{rung}'")

    rows = request["rows"]
    arm_levels = request["armLevels"]
    reference_arm = request["referenceArm"]
    coefficient_names = expected_coefficient_names(arm_levels, reference_arm)

    df = pd.DataFrame(rows)
    df["arm"] = pd.Categorical(df["arm"], categories=arm_levels)
    # Treatment coding with an EXPLICIT reference level -- must match
    # fit.mjs's expected_coefficient_names naming exactly (arm[T.<id>]),
    # since Node hard-fails on any mismatch rather than aligning positionally.
    formula = f"y ~ C(arm, Treatment(reference='{reference_arm}'))"

    if rung == "R0":
        # Nested brief:arm variance component via vc_formula, with `brief`
        # as the top-level grouping factor -- per #46's Specify-pass note:
        # brief is the single top-level group, brief:arm is nested INSIDE
        # it (not crossed random effects), which is exactly what vc_formula
        # models: one extra variance component per group, on top of the
        # group (brief) random intercept re_formula="1" already supplies.
        model = smf.mixedlm(
            formula,
            data=df,
            groups=df["brief"],
            re_formula="1",
            vc_formula={"brief:arm": "0 + C(arm)"},
        )
    else:  # R1
        model = smf.mixedlm(formula, data=df, groups=df["brief"], re_formula="1")

    result = model.fit(reml=True)

    # statsmodels names the Treatment-coded dummy columns like
    # "C(arm, Treatment(reference='A'))[T.B]" -- remap to the plain
    # "arm[T.B]" convention fit.mjs/contrasts.mjs standardize on, so Node
    # never has to parse a patsy formula string to know a coefficient name.
    prefix = f"C(arm, Treatment(reference='{reference_arm}'))"
    raw_names = list(result.fe_params.index)
    name_map = {}
    for raw in raw_names:
        if raw == "Intercept":
            name_map[raw] = "Intercept"
        elif raw.startswith(prefix + "[T."):
            arm_id = raw[len(prefix) + 3 : -1]
            name_map[raw] = f"arm[T.{arm_id}]"
        else:
            name_map[raw] = raw

    coefficients = [float(result.fe_params[raw]) for raw in raw_names]
    mapped_names = [name_map[raw] for raw in raw_names]

    # Reorder to match `coefficient_names` exactly (statsmodels' own column
    # order should already agree since armLevels/reference_arm drove the
    # categorical, but reordering explicitly makes the alignment an
    # assertion, not an assumption).
    if sorted(mapped_names) != sorted(coefficient_names) or len(mapped_names) != len(coefficient_names):
        raise ValueError(
            f"fitted coefficient set {mapped_names} does not match the expected {coefficient_names} "
            "-- refusing to emit a positionally-misaligned response"
        )
    order = [mapped_names.index(name) for name in coefficient_names]
    coefficients = [coefficients[i] for i in order]

    cov = result.cov_params()
    full_vcov_raw = cov.loc[raw_names, raw_names].to_numpy()
    vcov = full_vcov_raw[np.ix_(order, order)].tolist()

    variance_components = {}
    # result.cov_re is the group (brief) random-intercept covariance (1x1 here).
    try:
        variance_components["brief"] = float(np.asarray(result.cov_re)[0][0])
    except Exception:
        variance_components["brief"] = None
    if rung == "R0":
        # vc_formula variance components land in result.vcomp, named by the
        # vc_formula key ("brief:arm").
        try:
            vcomp = dict(zip(model.exog_vc.names, result.vcomp))
            variance_components["brief:arm"] = float(vcomp.get("brief:arm", float("nan")))
        except Exception:
            variance_components["brief:arm"] = None

    # Default to NOT converged when the attribute is missing (rather than
    # True) -- a missing `converged` must never silently look identical to
    # an explicit success and disable the R0->R1 descent criterion (#46 QA
    # SHOULD). statsmodels' MixedLMResults always sets this in practice, but
    # "defaults to converged" is exactly the kind of silent-degradation bug
    # this file's whole design (fail loud, never guess) exists to prevent.
    return {
        "converged": bool(getattr(result, "converged", False)),
        "coefficients": coefficients,
        "coefficientNames": coefficient_names,
        "vcov": vcov,
        "varianceComponents": variance_components,
        "n": int(len(df)),
        "toolchain": toolchain_versions(),
    }


def main():
    try:
        request = json.load(sys.stdin)
        response = fit(request)
    except Exception as exc:  # noqa: BLE001 -- a fit exception must exit non-zero, always
        print(f"fit_mixedlm.py: {exc}", file=sys.stderr)
        sys.exit(1)

    sys.stdout.write(json.dumps(response))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
