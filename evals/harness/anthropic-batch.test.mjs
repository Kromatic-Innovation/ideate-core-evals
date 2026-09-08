// anthropic-batch.test.mjs — hermetic tests for AnthropicBatchProvider
// (issue #19). No network, no real ideate-core call, no timers that actually
// wait -- every seam AnthropicBatchProvider exposes (fetchImpl, ideateImpl,
// sleep) is faked here, which is what keeps this file loadable under CI's
// `node --test` with an EMPTY node_modules (see the hermetic-CI invariant
// documented at the top of evals/harness/provider.mjs).
//
// Two kinds of fake `ideateImpl` are used below:
//   - `soloIdeateImpl` / `panelIdeateImpl`: mimic just enough of the REAL
//     ideate-core's calling convention (call `deps.complete({model, prompt,
//     temperature, ...})` once per agent, per round) to exercise the
//     provider's actual `complete` closure (the barrier-batcher, force-strip,
//     token capture) end-to-end, without importing ideate-core itself.
//   - a raw fake for the empty-pool / all-agents-failed cases, which just
//     returns a canned ideateCore-shaped result directly.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AnthropicBatchProvider,
  resolveIdeateAgents,
  resolvePanelGeometry,
  buildIdeateRounds,
  buildAnthropicMessageParams,
  buildOpenAIChatParams,
  UNIFORM_PERSONA,
  DEFAULT_MAX_POLL_MS,
} from "./provider.mjs";
import { buildRound1Prompt } from "./prompts.mjs";
import { runSpec } from "./runner.mjs";
import { ResultsStore } from "../../lib/store.mjs";
import { cellKey, configHash, planRun } from "../../lib/manifest.mjs";

const armsConfigJson = JSON.parse(
  await (await import("node:fs")).promises.readFile(new URL("../../arms.config.json", import.meta.url), "utf8"),
);

const CORPUS = [{ id: "brief-1", text: "Design a better bus stop." }];

function armsConfigFor(...armIds) {
  const arms = {};
  for (const id of armIds) arms[id] = armsConfigJson.arms[id];
  return { panel: armsConfigJson.panel, arms };
}

function cellFor(armId, briefId = "brief-1") {
  return { key: `arm=${armId}|brief=${briefId}|rep=0|cfg=abc`, armId, briefId, replicate: 0, cfg: "abc" };
}

const noopSleep = async () => {};
const silentLogger = () => {};

/**
 * A fake ideateImpl that drives deps.complete like ideate-core's real round-1
 * loop does: fire every agent CONCURRENTLY via Promise.all (so the provider's
 * barrier-batcher sees them all pushed within one microtask tick, exactly
 * like the real engine), parse each reply as a JSON array of {text}, and
 * return the ideateCore-shaped {candidates, agents, meta} result. No round 2.
 */
async function fakeIdeateImpl(input, deps) {
  const { complete, agents } = deps;
  const results = await Promise.all(
    agents.map((agent) =>
      complete({
        model: agent.model,
        prompt: `${deps.buildRound1Prompt({ context: input.context, persona: agent.persona, ideasPerAgent: agent.ideasPerAgent })}`,
        temperature: 0.7, // ideate-core ALWAYS sends this -- see DEFAULT_PERSONAS; the adapter must ignore it
        top_p: 0.9,
        maxTokens: 2048,
        persona: agent.persona,
      }),
    ),
  );
  const candidates = [];
  let agentsFailed = 0;
  results.forEach((res, i) => {
    if (!res || res.ok !== true) {
      agentsFailed++;
      return;
    }
    let raw;
    try {
      raw = JSON.parse(res.text);
    } catch {
      raw = [];
    }
    for (const c of raw) {
      if (c && typeof c.text === "string" && c.text) {
        candidates.push({ id: `${agents[i].id}-${candidates.length}`, text: c.text, agentId: agents[i].id, model: agents[i].model, persona: agents[i].persona, round: 1, origin: "generated" });
      }
    }
  });
  return {
    candidates,
    agents,
    meta: { agentsAttempted: agents.length, agentsFailed },
  };
}

// ── Arm -> ideate-core invocation mapping ────────────────────────────────────

test("resolveIdeateAgents: Arm A (solo) maps to a single agent, ideasPerAgent from totalIdeasRequested, maxRounds 1", () => {
  const arm = armsConfigJson.arms.A;
  const { agents, maxRounds } = resolveIdeateAgents(arm, armsConfigJson);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].model, "claude-sonnet-5");
  assert.equal(agents[0].ideasPerAgent, 30);
  assert.equal(maxRounds, 1);
});

test("resolveIdeateAgents: a panel arm maps one agent per slot, panel.ideasPerAgent/maxRounds from armsConfig", () => {
  const arm = armsConfigJson.arms.E; // tiered mix -- 2xHaiku, 2xSonnet, 1xOpus
  const { agents, maxRounds } = resolveIdeateAgents(arm, armsConfigJson);
  assert.equal(agents.length, 5);
  assert.deepEqual(agents.map((a) => a.model), ["claude-haiku-4-5", "claude-haiku-4-5", "claude-sonnet-5", "claude-sonnet-5", "claude-opus-5"]);
  assert.equal(maxRounds, armsConfigJson.panel.maxRounds);
  assert.ok(agents.every((a) => a.ideasPerAgent === armsConfigJson.panel.ideasPerAgent));
  // agent ids are unique even though two slots share persona "proposer_1" across
  // DIFFERENT arms is not the case here, but WITHIN one arm ids must still be
  // distinguishable per spec (`${slot.persona}#${i}`).
  assert.equal(new Set(agents.map((a) => a.id)).size, 5);
});

// ── issue #128: personaDisabled has a consumer, and slot levers are forwarded ─

test("#128: A' resolves to ONE identical explicit persona across all five slots -- the ablation is no longer arm B", () => {
  const { agents } = resolveIdeateAgents(armsConfigJson.arms["A'"], armsConfigJson);
  assert.equal(agents.length, 5);

  // Every persona-shaped field is IDENTICAL across the panel...
  for (const field of ["persona", "stance", "temperature", "strategy"]) {
    assert.equal(
      new Set(agents.map((a) => a[field])).size,
      1,
      `personaDisabled must give every slot the same ${field}`,
    );
  }

  // ...and every one is EXPLICITLY SET. This is the load-bearing half: an
  // unset field falls through to ideate-core's `DEFAULT_PERSONAS[i % 5]`
  // by-index fill (`spec.stance || base.stance`), which is exactly how the
  // five "identical" slots used to receive five DIFFERENT personas.
  for (const a of agents) {
    assert.equal(typeof a.stance, "string");
    assert.ok(a.stance.length > 0, "stance must be a non-empty string, or ideate-core fills it by index");
    assert.equal(typeof a.strategy, "string");
    assert.ok(a.strategy.length > 0);
    assert.ok(Number.isFinite(a.temperature), "temperature must be finite, or ideate-core fills it by index");
  }

  assert.equal(agents[0].stance, UNIFORM_PERSONA.stance);
});

test("#128: A' and B are no longer the same panel -- A' is uniform where B is differentiated", () => {
  const aPrime = resolveIdeateAgents(armsConfigJson.arms["A'"], armsConfigJson).agents;
  const b = resolveIdeateAgents(armsConfigJson.arms.B, armsConfigJson).agents;

  // Same models and same panel shape -- the ONLY difference is the persona lever.
  assert.deepEqual(aPrime.map((a) => a.model), b.map((a) => a.model));

  // A' carries one explicit stance; B carries none, so ideate-core fills B's
  // five slots from DEFAULT_PERSONAS BY INDEX -- five different personas. That
  // asymmetry is what makes the ablation an ablation.
  assert.ok(aPrime.every((a) => a.stance === UNIFORM_PERSONA.stance));
  assert.ok(b.every((a) => a.stance === undefined), "a non-personaDisabled arm forwards no stance of its own");
});

test("#128: personaDisabled does NOT disturb model assignment (the study's independent variable)", () => {
  const arm = {
    mode: "panel",
    personaDisabled: true,
    slots: [
      { persona: "proposer_uniform", model: "claude-haiku-4-5" },
      { persona: "proposer_uniform", model: "claude-opus-5" },
    ],
  };
  const { agents } = resolveIdeateAgents(arm, armsConfigJson);
  assert.deepEqual(agents.map((a) => a.model), ["claude-haiku-4-5", "claude-opus-5"]);
});

test("#128: a personaDisabled panel still gets UNIQUE agent ids (ideate-core#87 / IC-01)", () => {
  const { agents } = resolveIdeateAgents(armsConfigJson.arms["A'"], armsConfigJson);
  assert.equal(new Set(agents.map((a) => a.id)).size, agents.length);
});

test("#128: arm.uniformPersona overrides the harness default -- the config seam for the registration amendment (#129)", () => {
  const arm = {
    mode: "panel",
    personaDisabled: true,
    uniformPersona: { persona: "flat", stance: "STANCE FROM CONFIG", temperature: 0.1, strategy: "direct" },
    slots: [
      { persona: "proposer_uniform", model: "claude-haiku-4-5" },
      { persona: "proposer_uniform", model: "claude-haiku-4-5" },
    ],
  };
  const { agents } = resolveIdeateAgents(arm, armsConfigJson);
  assert.ok(agents.every((a) => a.stance === "STANCE FROM CONFIG"));
  assert.ok(agents.every((a) => a.persona === "flat"));
  assert.ok(agents.every((a) => a.temperature === 0.1));
  assert.ok(agents.every((a) => a.strategy === "direct"));
  assert.deepEqual(agents.map((a) => a.id), ["flat#0", "flat#1"]);
});

test("#128: a personaDisabled arm with no uniformPersona still gets an explicit persona, never an unset one", () => {
  // Defense against the defect recurring in a FUTURE ablation arm: the switch
  // alone is enough; forgetting to write a uniformPersona block cannot silently
  // reopen the by-index fallback.
  const arm = {
    mode: "panel",
    personaDisabled: true,
    slots: [{ persona: "x", model: "m" }, { persona: "y", model: "m" }],
  };
  const { agents } = resolveIdeateAgents(arm, armsConfigJson);
  assert.equal(new Set(agents.map((a) => a.stance)).size, 1);
  assert.equal(agents[0].stance, UNIFORM_PERSONA.stance);
});

test("#128: slot-level stance/temperature/strategy are forwarded verbatim on the panel path", () => {
  const arm = {
    mode: "panel",
    personaDisabled: false,
    slots: [
      { persona: "p1", model: "claude-haiku-4-5", stance: "S1", temperature: 0.15, strategy: "direct" },
      { persona: "p2", model: "claude-haiku-4-5" },
    ],
  };
  const { agents } = resolveIdeateAgents(arm, armsConfigJson);
  assert.deepEqual(
    { stance: agents[0].stance, temperature: agents[0].temperature, strategy: agents[0].strategy },
    { stance: "S1", temperature: 0.15, strategy: "direct" },
  );
  // A slot that specifies nothing stays UNSET, so ideate-core's documented
  // fill-from-DEFAULT_PERSONAS behaviour is preserved for arms B-H exactly as
  // it was before #128. This change is additive, not a behaviour change for
  // the arms that never named a lever.
  assert.equal(agents[1].stance, undefined);
  assert.equal(agents[1].temperature, undefined);
  assert.equal(agents[1].strategy, undefined);
});

test("#128: personaDisabled applies on the SOLO path too -- the flag cannot be a no-op in one mode", () => {
  // No registered arm is solo AND persona-disabled today (arm A sets
  // `personaDisabled: false`), which is exactly why this is pinned now: a flag
  // that silently applies in one branch only is the same no-consumer defect
  // #128 reports, merely relocated to whichever ablation gets registered next.
  const arm = {
    mode: "solo",
    personaDisabled: true,
    totalIdeasRequested: 30,
    slots: [{ persona: "solo", model: "claude-sonnet-5" }],
  };
  const { agents } = resolveIdeateAgents(arm, armsConfigJson);
  assert.equal(agents[0].stance, UNIFORM_PERSONA.stance);
  assert.equal(agents[0].persona, UNIFORM_PERSONA.persona);
  assert.equal(agents[0].strategy, UNIFORM_PERSONA.strategy);
  assert.ok(Number.isFinite(agents[0].temperature));
  // ...and the model still comes from the slot, not the persona.
  assert.equal(agents[0].model, "claude-sonnet-5");
});

test("#128: arm A (personaDisabled: false) is untouched by the solo-path uniform logic", () => {
  const { agents, maxRounds } = resolveIdeateAgents(armsConfigJson.arms.A, armsConfigJson);
  assert.equal(maxRounds, 1);
  assert.equal(agents[0].persona, "solo");
  assert.equal(agents[0].model, "claude-sonnet-5");
  assert.equal(agents[0].ideasPerAgent, 30);
  assert.equal(agents[0].stance, undefined, "arm A names no stance, so ideate-core still fills it -- unchanged by #128");
});

test("#128: slot-level stance/temperature/strategy are forwarded on the SOLO path too (arm A)", () => {
  const arm = {
    mode: "solo",
    totalIdeasRequested: 30,
    slots: [{ persona: "solo", model: "claude-sonnet-5", stance: "SOLO STANCE", temperature: 0.33, strategy: "cot" }],
  };
  const { agents, maxRounds } = resolveIdeateAgents(arm, armsConfigJson);
  assert.equal(maxRounds, 1);
  assert.equal(agents[0].stance, "SOLO STANCE");
  assert.equal(agents[0].temperature, 0.33);
  assert.equal(agents[0].strategy, "cot");
  assert.equal(agents[0].ideasPerAgent, 30);
});

test("#128: arms.config.json's registered arms A-H are unchanged by the forwarding -- they name no lever", () => {
  for (const [id, arm] of Object.entries(armsConfigJson.arms)) {
    if (arm.personaDisabled) continue;
    const { agents } = resolveIdeateAgents(arm, armsConfigJson);
    for (const a of agents) {
      assert.equal(a.stance, undefined, `arm ${id} must forward no stance of its own`);
      assert.equal(a.temperature, undefined, `arm ${id} must forward no temperature of its own`);
      assert.equal(a.strategy, undefined, `arm ${id} must forward no strategy of its own`);
    }
  }
});

// ── The forwarded fields' real reach, pinned (issue #128) ────────────────────
// Forwarding a field that nothing consumes is the very defect #128 reports, so
// each field's actual reach is asserted rather than assumed.

test("#128: a forwarded stance REACHES the submitted prompt", () => {
  const withStance = buildRound1Prompt({ context: "ctx", persona: "p", stance: "UNIQUE-STANCE-MARKER", ideasPerAgent: 6 });
  assert.ok(withStance.includes("UNIQUE-STANCE-MARKER"), "stance must be rendered into the round-1 prompt");
  const withoutStance = buildRound1Prompt({ context: "ctx", persona: "p", ideasPerAgent: 6 });
  assert.ok(!withoutStance.includes("UNIQUE-STANCE-MARKER"));
  assert.notEqual(withStance, withoutStance);
});

test("#128: a forwarded temperature is RECORDED but never submitted -- PREREGISTRATION §3.3 strips it universally", () => {
  const params = buildAnthropicMessageParams({ model: "claude-haiku-4-5", prompt: "p", maxTokens: 100, temperature: 0.9, top_p: 0.5, top_k: 40 });
  assert.equal(params.temperature, undefined);
  assert.equal(params.top_p, undefined);
  assert.equal(params.top_k, undefined);
  assert.deepEqual(Object.keys(params).sort(), ["max_tokens", "messages", "model"]);
});

test("#128: a forwarded strategy does NOT yet change the prompt -- the lever is registered to #129, not shipped here", () => {
  // This harness injects its OWN buildRound1Prompt/buildRound2Prompt into
  // ideate-core, and they do not branch on strategy, so direct-vs-CoT is not
  // yet a variable lever at the wire. Asserted, not assumed: if a future change
  // makes the prompt strategy-sensitive, this test fails and the residual noted
  // in resolveIdeateAgents' header must be updated with it.
  const cot = buildRound1Prompt({ context: "ctx", persona: "p", stance: "s", ideasPerAgent: 6, strategy: "cot" });
  const direct = buildRound1Prompt({ context: "ctx", persona: "p", stance: "s", ideasPerAgent: 6, strategy: "direct" });
  assert.equal(cot, direct);
});

// ── issue #129 amendment A: `effort` forwarding ──────────────────────────────
// Two SEPARATE tests for the solo and panel branches: a single test covering
// both would leave a mutation that breaks only one branch undetected.

test("#129: a slot-level effort is forwarded verbatim on the SOLO path", () => {
  const arm = {
    mode: "solo",
    totalIdeasRequested: 30,
    slots: [{ persona: "solo", model: "claude-sonnet-5", effort: "low" }],
  };
  const { agents } = resolveIdeateAgents(arm, armsConfigJson);
  assert.equal(agents[0].effort, "low");
});

test("#129: a slot-level effort is forwarded verbatim on the PANEL path", () => {
  const arm = {
    mode: "panel",
    personaDisabled: false,
    slots: [
      { persona: "p1", model: "claude-sonnet-5", effort: "xhigh" },
      { persona: "p2", model: "claude-sonnet-5" },
    ],
  };
  const { agents } = resolveIdeateAgents(arm, armsConfigJson);
  assert.equal(agents[0].effort, "xhigh");
  // A slot that names no effort stays UNSET -- undefined must stay
  // distinguishable from an explicit value, per ideate-core@0.5.0's own
  // plain-assignment contract (never `||`-defaulted).
  assert.equal(agents[1].effort, undefined);
});

test("#129: an unset solo effort resolves to undefined, not a coerced falsy value", () => {
  const { agents } = resolveIdeateAgents(armsConfigJson.arms.A, armsConfigJson);
  assert.equal(agents[0].effort, undefined);
});

test("#129: effort is read from the RAW slot, not the uniformPersona overlay -- a personaDisabled arm cannot silently blank or override it", () => {
  const arm = {
    mode: "panel",
    personaDisabled: true,
    uniformPersona: { effort: "max" }, // must be IGNORED -- effort is not a persona field
    slots: [
      { persona: "p1", model: "claude-haiku-4-5", effort: "low" },
      { persona: "p2", model: "claude-haiku-4-5" },
    ],
  };
  const { agents } = resolveIdeateAgents(arm, armsConfigJson);
  assert.equal(agents[0].effort, "low", "the slot's own effort must win over uniformPersona.effort");
  assert.equal(agents[1].effort, undefined, "uniformPersona.effort must not backfill an unset slot effort either");
});

// ── issue #129 amendment C: effort reaches the request builders ─────────────

test("#129: buildAnthropicMessageParams emits output_config.effort when the request carries one, and omits it otherwise", () => {
  const withEffort = buildAnthropicMessageParams({ model: "claude-sonnet-5", prompt: "p", effort: "high" });
  assert.deepEqual(withEffort.output_config, { effort: "high" });

  const withoutEffort = buildAnthropicMessageParams({ model: "claude-sonnet-5", prompt: "p" });
  assert.equal(withoutEffort.output_config, undefined);
  assert.deepEqual(Object.keys(withoutEffort).sort(), ["max_tokens", "messages", "model"]);
});

test("#129: buildAnthropicMessageParams throws fail-loud for a model outside Anthropic's documented effort support (Haiku 4.5)", () => {
  assert.throws(
    () => buildAnthropicMessageParams({ model: "claude-haiku-4-5", prompt: "p", effort: "low" }),
    /does not support output_config\.effort/,
  );
  // No effort at all is still fine on Haiku -- only an EXPLICIT effort is rejected.
  assert.doesNotThrow(() => buildAnthropicMessageParams({ model: "claude-haiku-4-5", prompt: "p" }));
});

test("#129: buildOpenAIChatParams emits reasoning_effort verbatim when the request carries one, and omits it otherwise", () => {
  const withEffort = buildOpenAIChatParams({ model: "gpt-5.6-terra", prompt: "p", effort: "medium" });
  assert.equal(withEffort.reasoning_effort, "medium");

  const withoutEffort = buildOpenAIChatParams({ model: "gpt-5.6-terra", prompt: "p" });
  assert.equal(withoutEffort.reasoning_effort, undefined);
  assert.deepEqual(Object.keys(withoutEffort).sort(), ["max_completion_tokens", "messages", "model"]);
});

// ── issue #129 amendment B: per-arm panel geometry overrides ────────────────

test("#129: an unset per-arm panel override inherits the global panel default", () => {
  const arm = { mode: "panel", slots: armsConfigJson.arms.C.slots };
  const panel = resolvePanelGeometry(arm, armsConfigJson);
  assert.equal(panel.ideasPerAgent, armsConfigJson.panel.ideasPerAgent);
  assert.equal(panel.maxRounds, armsConfigJson.panel.maxRounds);
  assert.equal(panel.size, armsConfigJson.panel.size);
  assert.equal(panel.sharing, undefined, "the global block never sets sharing today -- the registered default is undefined");
});

test("#129: a per-arm panel override wins over the global default, and resolveIdeateAgents actually uses the override, not the fallen-back value", () => {
  const arm = {
    mode: "panel",
    panel: { ideasPerAgent: 99, maxRounds: 7, sharing: "blind" },
    slots: armsConfigJson.arms.C.slots,
  };
  const { agents, maxRounds, sharing } = resolveIdeateAgents(arm, armsConfigJson);
  assert.notEqual(99, armsConfigJson.panel.ideasPerAgent, "sanity: the override value must differ from the global default");
  assert.ok(agents.every((a) => a.ideasPerAgent === 99), "resolveIdeateAgents must use the OVERRIDE, not silently fall back to the global panel.ideasPerAgent");
  assert.equal(maxRounds, 7);
  assert.equal(sharing, "blind");
});

test("#129: a per-arm override of only ONE field leaves the others inherited from the global default", () => {
  const arm = { mode: "panel", panel: { maxRounds: 4 }, slots: armsConfigJson.arms.C.slots };
  const panel = resolvePanelGeometry(arm, armsConfigJson);
  assert.equal(panel.maxRounds, 4);
  assert.equal(panel.ideasPerAgent, armsConfigJson.panel.ideasPerAgent, "ideasPerAgent was not overridden -- must inherit");
});

test("#129: panel.size is validated against arm.slots.length -- a mismatch throws fail-loud, not silently ignored", () => {
  const consistent = { mode: "panel", panel: { size: 5 }, slots: armsConfigJson.arms.C.slots };
  assert.doesNotThrow(() => resolveIdeateAgents(consistent, armsConfigJson));

  const inconsistent = { mode: "panel", panel: { size: 3 }, slots: armsConfigJson.arms.C.slots };
  assert.throws(() => resolveIdeateAgents(inconsistent, armsConfigJson), /has 5 slots but its panel\.size override is 3/);
});

test("#129: panel.size is NOT enforced against the inherited GLOBAL default -- only an arm's OWN override is validated", () => {
  // The global panel block sets size: 5; an ad-hoc 2-slot test arm that never
  // opts into a per-arm size override must not be held to it -- that would be
  // a scope-creeping behavior change (see resolvePanelGeometry's header).
  const arm = { mode: "panel", slots: [{ persona: "p1", model: "claude-haiku-4-5" }, { persona: "p2", model: "claude-haiku-4-5" }] };
  assert.doesNotThrow(() => resolveIdeateAgents(arm, armsConfigJson));
});

test("#129: sharing applies to build-on rounds only (round 1 is never consulted) -- buildIdeateRounds", () => {
  assert.equal(buildIdeateRounds(2, undefined), undefined, "no sharing set -> no rounds array, inherits ideate-core's own default");
  const rounds = buildIdeateRounds(2, "pool");
  assert.equal(rounds.length, 2);
  // Index 0 (round 1) is written but ideate-core's roundConfig(round, deps)
  // is only ever called for round >= 2 -- see node_modules/ideate-core/lib/
  // ideate-core.mjs's build-on-rounds loop -- so a real round-1 override is
  // structurally impossible via this mechanism, by design.
  assert.deepEqual(rounds, [{ sharing: "pool" }, { sharing: "pool" }]);
});

// ── issue #129 amendment F: stance-neutral solo control (arm AS) ────────────

test("#129: arm AS is registered, personaDisabled, and resolves to an explicit stance-neutral persona", () => {
  const arm = armsConfigJson.arms.AS;
  assert.ok(arm, "arm AS must be registered in arms.config.json");
  assert.equal(arm.mode, "solo");
  assert.equal(arm.personaDisabled, true);
  const { agents, maxRounds } = resolveIdeateAgents(arm, armsConfigJson);
  assert.equal(maxRounds, 1);
  assert.equal(agents[0].stance, UNIFORM_PERSONA.stance);
});

test("#129: arm AS differs from arm A in STANCE ONLY -- model, strategy, temperature and rounds all match arm A", () => {
  const a = resolveIdeateAgents(armsConfigJson.arms.A, armsConfigJson);
  const as = resolveIdeateAgents(armsConfigJson.arms.AS, armsConfigJson);

  // Arm A's slot persona "solo" is not a DEFAULT_PERSONAS name, so ideate-core
  // resolves it to DEFAULT_PERSONAS[0] (PRAGMATIST: temperature 0.4, strategy
  // "direct") when stance/temperature/strategy are left unset, exactly as
  // resolveIdeateAgents' arm-A-unchanged test above pins. AS's uniformPersona
  // override reproduces those same values explicitly, so the two arms match on
  // everything EXCEPT stance (present vs. deliberately neutral) and persona
  // name (a labeling difference, not a measured lever).
  assert.equal(as.agents[0].model, a.agents[0].model, "model must match -- AS isolates stance, not the model lever");
  assert.equal(as.agents[0].strategy, "direct", "AS must not also flip strategy to cot -- that would confound a second lever");
  assert.equal(as.agents[0].temperature, 0.4, "AS must reproduce arm A's resolved PRAGMATIST temperature, not UNIFORM_PERSONA's 0.8 default");
  assert.equal(as.maxRounds, a.maxRounds);
  assert.equal(as.agents[0].ideasPerAgent, a.agents[0].ideasPerAgent);
  assert.notEqual(as.agents[0].stance, a.agents[0].stance === undefined ? "" : a.agents[0].stance, "stance is the one lever that must actually differ");
  assert.equal(as.agents[0].stance, UNIFORM_PERSONA.stance);
});

test("generate() covers the solo path (Arm A) end-to-end via a fake ideateImpl and completes", async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    return jsonResponse(200, { id: "batch_1", processing_status: "ended", results_url: "https://fake/results" });
  };
  // Not exercised directly -- generate() below routes to #completeBatched,
  // which needs both the submit AND the results fetch; build a routing fake.
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: routingFetch({
      onSubmit: (body) => ({
        id: "batch_1",
        processing_status: "ended",
        results_url: "https://fake/results",
      }),
      onResults: (body, submitted) => submitted.requests.map((r) => resultLine(r.custom_id, textResult(`[{"text":"idea for ${r.custom_id}"}]`))),
    }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.result.candidates.length, 1); // solo: one agent, one reply of one candidate in this fake
});

test("generate() covers the panel path end-to-end via a fake ideateImpl and completes", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("B"),
    fetchImpl: routingFetch({
      onSubmit: () => ({ id: "batch_2", processing_status: "ended", results_url: "https://fake/results" }),
      onResults: (body, submitted) =>
        submitted.requests.map((r) => resultLine(r.custom_id, textResult(`[{"text":"idea A"},{"text":"idea B"}]`))),
    }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("B"), armsConfigJson.arms.B, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  // Arm B is a 5-agent homogeneous-Haiku panel; each agent's fake reply has 2 candidates.
  assert.equal(resp.result.candidates.length, 10);
});

// ── Force-strip: no temperature/top_p/top_k for ANY model, Haiku included ───

test("buildAnthropicMessageParams never carries temperature/top_p/top_k, for every model in arms.config.json (Haiku included)", () => {
  const modelIds = new Set();
  for (const arm of Object.values(armsConfigJson.arms)) {
    for (const slot of arm.slots || []) {
      if (slot.model && slot.model.startsWith("claude-")) modelIds.add(slot.model); // Anthropic ids only -- OpenAI is a separate adapter/issue
    }
  }
  assert.ok(modelIds.has("claude-haiku-4-5"), "sanity: Haiku must be among the models under test");
  for (const model of modelIds) {
    const params = buildAnthropicMessageParams({ model, prompt: "hi", temperature: 0.9, top_p: 0.8, top_k: 40, maxTokens: 111 });
    assert.equal(params.model, model);
    assert.equal(params.max_tokens, 111);
    assert.ok(!("temperature" in params), `model ${model} must not carry temperature`);
    assert.ok(!("top_p" in params), `model ${model} must not carry top_p`);
    assert.ok(!("top_k" in params), `model ${model} must not carry top_k`);
  }
});

test("force-strip end-to-end: a fake fetchImpl captures every submitted batch request and none carries temperature/top_p/top_k, across a Haiku panel", async () => {
  const captured = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("B"), // Arm B: homogeneous Haiku -- the case §3.3 is about
    fetchImpl: routingFetch({
      onSubmit: (body) => {
        captured.push(...body.requests);
        return { id: "batch_3", processing_status: "ended", results_url: "https://fake/results" };
      },
      onResults: (body, submitted) => submitted.requests.map((r) => resultLine(r.custom_id, textResult(`[{"text":"x"}]`))),
    }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  await provider.generate(cellFor("B"), armsConfigJson.arms.B, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(captured.length, 5); // 5-agent panel
  for (const req of captured) {
    assert.ok(!("temperature" in req.params), "no submitted request may carry temperature, Haiku included");
    assert.ok(!("top_p" in req.params));
    assert.ok(!("top_k" in req.params));
  }
});

// ── custom_id keying: reversed result order still maps correctly ───────────

test("custom_id keying: batch results returned in REVERSED order still map to the correct agent", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("B"),
    fetchImpl: routingFetch({
      onSubmit: () => ({ id: "batch_4", processing_status: "ended", results_url: "https://fake/results" }),
      onResults: (body, submitted) => {
        // Distinguishable text per request (echo the custom_id back), then
        // return the lines in REVERSED order -- must still map correctly
        // because the provider keys by custom_id, not array/line position.
        const lines = submitted.requests.map((r) => resultLine(r.custom_id, textResult(`[{"text":"idea-from-${r.custom_id}"}]`)));
        return lines.reverse();
      },
    }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("B"), armsConfigJson.arms.B, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  const texts = resp.result.candidates.map((c) => c.text);
  // Every agent's own distinguishable idea shows up despite reversed results.
  assert.equal(texts.length, 5);
  assert.equal(new Set(texts).size, 5, "each agent's reply must be distinct and correctly attributed");
});

// ── no-throw transport failure ──────────────────────────────────────────────

test("a rejecting fetchImpl on batch submit resolves generate() with a classified transport_error, never throws", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    maxRetries: 0,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "transport_error");
});

test("a 500 on batch submit resolves generate() with a classified transport_error, never throws", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => jsonResponse(500, { error: "boom" }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    maxRetries: 0,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "transport_error");
});

// ── rate_limited ─────────────────────────────────────────────────────────────

test("HTTP 429 that persists after retries classifies as rate_limited", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => jsonResponse(429, { error: "slow down" }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    maxRetries: 2,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "rate_limited");
});

// ── empty_pool ───────────────────────────────────────────────────────────────

test("ideateImpl resolving with candidates: [] classifies as failed/empty_pool", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => {
      throw new Error("should not be called -- ideateImpl never calls complete() in this fake");
    },
    ideateImpl: async () => ({ candidates: [], agents: [], meta: { agentsAttempted: 1, agentsFailed: 0 } }),
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "empty_pool");
});

test("ideateImpl resolving with an empty pool AND every agent failed classifies as refusal", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
    ideateImpl: async () => ({ candidates: [], agents: [], meta: { agentsAttempted: 1, agentsFailed: 1 } }),
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "refusal");
});

// ── token capture ────────────────────────────────────────────────────────────

test("a completed cell returns tokens.tokens_by_model with per-model input/output sums matching the fake usage", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("E"), // mixed tier: 2xHaiku, 2xSonnet, 1xOpus
    fetchImpl: routingFetch({
      onSubmit: () => ({ id: "batch_5", processing_status: "ended", results_url: "https://fake/results" }),
      onResults: (body, submitted) =>
        submitted.requests.map((r) =>
          resultLine(
            r.custom_id,
            textResult(`[{"text":"x"}]`, { input_tokens: 100, output_tokens: 50 }),
          ),
        ),
    }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("E"), armsConfigJson.arms.E, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  const byModel = resp.tokens.tokens_by_model;
  // Arm E: 2xHaiku, 2xSonnet, 1xOpus -- each contributing agent's usage sums per model.
  assert.equal(byModel["claude-haiku-4-5"].input_tokens, 200);
  assert.equal(byModel["claude-haiku-4-5"].output_tokens, 100);
  assert.equal(byModel["claude-sonnet-5"].input_tokens, 200);
  assert.equal(byModel["claude-opus-5"].input_tokens, 100);
  assert.equal(byModel["claude-opus-5"].output_tokens, 50);
});

test("tokens are captured even on a failed cell (whatever was consumed before the failure)", async () => {
  let call = 0;
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async (url) => {
      call++;
      if (String(url).includes("/batches") && !String(url).includes("results")) {
        // submit succeeds
        if (call === 1) return jsonResponse(200, { id: "batch_6", processing_status: "ended", results_url: "https://fake/results" });
      }
      // results fetch fails
      return jsonResponse(500, {});
    },
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    maxRetries: 0,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.ok(resp.tokens && resp.tokens.tokens_by_model, "tokens shape must always be present, even on failure");
});

// ── batch vs single mode ────────────────────────────────────────────────────

test("mode: 'single' hits /v1/messages, not /v1/messages/batches", async () => {
  const urls = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async (url) => {
      urls.push(String(url));
      return jsonResponse(200, { content: [{ type: "text", text: '[{"text":"idea"}]' }], usage: { input_tokens: 10, output_tokens: 5 } });
    },
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "single", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  assert.ok(urls.every((u) => u === "https://api.anthropic.com/v1/messages"));
  assert.ok(!urls.some((u) => u.includes("/batches")));
});

test("mode: 'batch' hits /v1/messages/batches, not the plain /v1/messages endpoint", async () => {
  const urls = [];
  const baseFetch = routingFetch({
    onSubmit: () => ({ id: "batch_7", processing_status: "ended", results_url: "https://fake/results" }),
    onResults: (body, submitted) => submitted.requests.map((r) => resultLine(r.custom_id, textResult('[{"text":"x"}]'))),
  });
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async (url, opts) => {
      urls.push(String(url));
      return baseFetch(url, opts);
    },
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  assert.ok(urls.some((u) => u === "https://api.anthropic.com/v1/messages/batches"));
  assert.ok(!urls.includes("https://api.anthropic.com/v1/messages"));
});

// ── ANTHROPIC_API_KEY guard ──────────────────────────────────────────────────

test("no apiKey: generate() returns a classified failure rather than throwing", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: undefined,
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => {
      throw new Error("must never be called with no apiKey");
    },
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });
  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "harness_error");
});

// ── issue #92: the batch poll ceiling ───────────────────────────────────────
//
// Everything below is hermetic: `stuckBatchFetch` models a batch that never
// leaves `in_progress`, and `maxPollMs: -1` puts the deadline in the past so
// the ceiling fires on the first check. No timers wait, no network is touched.

test("#92: the live default poll ceiling is 60 minutes (DEFAULT_MAX_POLL_MS), not the old 15", () => {
  assert.equal(DEFAULT_MAX_POLL_MS, 60 * 60 * 1000);
  const provider = new AnthropicBatchProvider({ apiKey: "test-key", logger: silentLogger });
  assert.equal(provider.maxPollMs, DEFAULT_MAX_POLL_MS, "the constructor default must BE the constant, not a second hardcoded number");
  assert.notEqual(provider.maxPollMs, 15 * 60 * 1000, "15 minutes is shorter than observed batch latency -- issue #92");
});

test("#92: a non-finite maxPollMs is rejected at construction -- a NaN ceiling would never expire, hanging the poll loop forever", () => {
  assert.throws(() => new AnthropicBatchProvider({ apiKey: "k", maxPollMs: NaN }), /maxPollMs must be a finite number/);
  assert.throws(() => new AnthropicBatchProvider({ apiKey: "k", maxPollMs: undefined_but_string() }), /maxPollMs must be a finite number/);
  // An explicit zero/negative ceiling is a legitimate "give up immediately"
  // (the tests below rely on it) and must NOT be rejected.
  assert.equal(new AnthropicBatchProvider({ apiKey: "k", maxPollMs: -1 }).maxPollMs, -1);
});
function undefined_but_string() {
  return "not-a-number";
}

test("#92: a batch that outruns the ceiling fails as `timeout` and the ledger detail says POLL_CEILING_REACHED with the abandoned handle", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl: stuckBatchFetch(),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "timeout");
  // THE discriminator the issue asks for: an operator reading the ledger must
  // be able to tell "we gave up waiting" from "the API failed". Both would be
  // `timeout`-shaped without this token, and a transport failure carries no
  // batch handle to recover from.
  assert.match(resp.detail, /POLL_CEILING_REACHED/);
  assert.match(resp.detail, /gave up waiting; the API did NOT fail/);
  assert.match(resp.detail, /batch_stuck/, "the durable batch handle is in the ledger, so the operator can re-poll or cancel it by hand");
  assert.match(resp.detail, /"max_poll_ms":-1/);
  assert.match(resp.detail, /"last_status":"in_progress"/);
});

test("#92: abandoning a batch CANCELS it (POST .../cancel) so it cannot bill unattended, and records the cancel outcome", async () => {
  const cancels = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl: stuckBatchFetch({ onCancel: (u) => cancels.push(u) }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.deepEqual(cancels, ["https://api.anthropic.com/v1/messages/batches/batch_stuck/cancel"]);
  assert.match(resp.detail, /"cancelled":true/);
});

test("#92: cancelOnAbandon: false leaves the handle live for a manual re-poll and records cancelled: null", async () => {
  const cancels = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    cancelOnAbandon: false,
    fetchImpl: stuckBatchFetch({ onCancel: (u) => cancels.push(u) }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.deepEqual(cancels, [], "no cancel is issued when the operator opted out");
  assert.equal(resp.failureKind, "timeout");
  assert.match(resp.detail, /"cancelled":null/);
});

test("#92: a cancel that FAILS never changes the failure kind, and says so in the ledger so the operator knows a batch may still bill", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl: stuckBatchFetch({ cancelStatus: 500 }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(resp.failureKind, "timeout", "a failed cancel is not a different failure -- the cell still timed out");
  assert.match(resp.detail, /"cancelled":false/);
});

test("#92: a PARTIAL pool whose later round outran the ceiling is FAILED, never stored as a completed (silently truncated) pool", async () => {
  // Panel arms run panel.maxRounds (2) rounds. Round 1's batch ends normally;
  // round 2's never does. Without the guard this test pins, ideate-core
  // resolves with round 1's candidates and the cell stores as `completed`
  // carrying half a pool -- an arm-correlated under-count of distinct_k on
  // exactly the panel arms H1 compares against solo.
  let batchSeq = 0;
  let round1CustomIds = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/messages/batches")) {
      batchSeq += 1;
      if (batchSeq === 1) {
        round1CustomIds = JSON.parse(opts.body).requests.map((r) => r.custom_id);
        return jsonResponse(200, { id: "batch_round1", processing_status: "ended", results_url: "https://fake/results" });
      }
      return jsonResponse(200, { id: "batch_stuck", processing_status: "in_progress" });
    }
    if (u.includes("/v1/messages/batches/")) return jsonResponse(200, { id: "batch_stuck", processing_status: "in_progress" });
    if (u === "https://fake/results") {
      return textResponse(round1CustomIds.map((id) => JSON.stringify(resultLine(id, textResult('[{"text":"round-1 idea"}]')))).join("\n"));
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl,
    // A two-round engine: round 1 resolves, round 2 is abandoned at the
    // ceiling, and the engine (like the real one) still returns round 1's work.
    ideateImpl: async (input, deps) => {
      const agent = deps.agents[0];
      const r1 = await deps.complete({ model: agent.model, prompt: "round 1", persona: agent.persona });
      await deps.complete({ model: agent.model, prompt: "round 2", persona: agent.persona });
      const candidates = r1 && r1.ok ? [{ text: "round-1 idea", model: agent.model }] : [];
      return { candidates, agents: deps.agents, meta: { agentsAttempted: 1, agentsFailed: 0 } };
    },
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(resp.terminalState, "failed", "a pool assembled while a paid-for batch was still outstanding is not a measurement");
  assert.equal(resp.failureKind, "timeout");
  assert.match(resp.detail, /POLL_CEILING_REACHED/);
  assert.match(resp.detail, /discarding a PARTIAL pool of 1 candidate/);
});

test("#92: once a cell has abandoned a batch, a LATER round submits no second batch -- the ceiling is a per-cell bound, not a per-batch one", async () => {
  // Without the short-circuit this pins, a 2-round panel cell whose round-1
  // batch blew the ceiling would submit round 2 as a fresh batch and poll it
  // for another full maxPollMs -- paying real money for a pool the
  // partial-pool guard has already decided to discard.
  const submits = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/v1/messages/batches")) submits.push(u);
      return stuckBatchFetch()(url, opts);
    },
    ideateImpl: async (input, deps) => {
      const agent = deps.agents[0];
      await deps.complete({ model: agent.model, prompt: "round 1", persona: agent.persona });
      await deps.complete({ model: agent.model, prompt: "round 2", persona: agent.persona });
      return { candidates: [], agents: deps.agents, meta: { agentsAttempted: 1, agentsFailed: 1 } };
    },
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(resp.failureKind, "timeout");
  assert.equal(submits.length, 1, "exactly ONE batch was submitted -- round 2 must not re-submit for a cell already given up on");
});

test("#92 + #90 END TO END: a cell lost to the poll ceiling is NOT stored under cell.key and is re-planned todo on the next invocation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ideate-poll-ceiling-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const cfg = { harnessVersion: "0.0.1", engineSha: "test-sha", promptHash: "test-prompt" };
  const spec = { arms: [{ id: "A" }], briefs: [{ id: "brief-1" }], replicates: 1, config: cfg };
  const key = cellKey({ armId: "A", briefId: "brief-1", replicate: 0, cfg: configHash(cfg) });

  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl: stuckBatchFetch(),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const store = new ResultsStore(dir);
  const { summary } = await runSpec(spec, { store, armsConfig: armsConfigFor("A"), provider, log: () => {} });
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.byKind, { timeout: 1 });

  // The #90 property, verified against the REAL ceiling path rather than
  // assumed from `timeout` being in TRANSIENT_FAILURE_KINDS: nothing under
  // cell.key, so planRun re-plans it instead of classifying it `reuse` forever.
  assert.equal(store.has(key), false, "the ceiling must not permanently consume the cell");
  const store2 = new ResultsStore(dir);
  assert.deepEqual(planRun(spec, store2.keys()).todo.map((c) => c.key), [key], "the next invocation re-plans it todo");

  // And the reason is durable: the attempt record carries the kind AND the
  // abandoned batch handle, so "why is this cell todo again?" is answerable
  // from the store alone.
  const attempt = store2.get(`generation-attempt|cell=${key}|attempt=0`);
  assert.equal(attempt.accounting.kind, "timeout");
  assert.match(attempt.accounting.detail, /POLL_CEILING_REACHED/);
  assert.match(attempt.accounting.detail, /batch_stuck/);
});

// ── test fixtures/helpers ────────────────────────────────────────────────────

/**
 * A batch that submits fine and then never leaves `in_progress` -- the exact
 * shape `msgbatch_01F9QXDpNptrrGfD4z3RzpGX` had when the #8 smoke run was
 * killed. `onCancel` records the cancel URL; `cancelStatus` forces the cancel
 * call to fail so the "cancel failed" path is exercised.
 */
function stuckBatchFetch({ onCancel, cancelStatus = 200 } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith("/cancel")) {
      if (onCancel) onCancel(u);
      return jsonResponse(cancelStatus, { id: "batch_stuck", processing_status: "canceling" });
    }
    if (u.endsWith("/v1/messages/batches")) return jsonResponse(200, { id: "batch_stuck", processing_status: "in_progress" });
    if (u.includes("/v1/messages/batches/")) return jsonResponse(200, { id: "batch_stuck", processing_status: "in_progress" });
    throw new Error(`stuckBatchFetch: unexpected URL ${u}`);
  };
}


function jsonResponse(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/** One JSONL result row keyed by custom_id, per the Message Batches results shape. */
function resultLine(custom_id, result) {
  return { custom_id, result };
}

/** A "succeeded" batch result entry wrapping a text-content Anthropic message. */
function textResult(jsonArrayText, usage = { input_tokens: 10, output_tokens: 5 }) {
  return { type: "succeeded", message: { content: [{ type: "text", text: jsonArrayText }], usage } };
}

/**
 * Build a fetchImpl that routes POST .../batches (submit) to `onSubmit`,
 * GET .../batches/:id (poll) to an immediate "ended" (submit already reports
 * ended in these tests -- no separate poll roundtrip needed), and GET the
 * results_url to `onResults`, returning them as a JSONL body -- exactly the
 * shape #flush() expects to parse.
 */
function routingFetch({ onSubmit, onResults }) {
  let submittedBody;
  return async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/messages/batches")) {
      submittedBody = JSON.parse(opts.body);
      const out = onSubmit(submittedBody);
      return jsonResponse(200, out);
    }
    if (u.includes("/v1/messages/batches/")) {
      // poll -- not exercised in these fixtures since onSubmit already
      // reports processing_status: "ended"; return the same shape defensively.
      return jsonResponse(200, { id: "batch", processing_status: "ended", results_url: "https://fake/results" });
    }
    if (u === "https://fake/results") {
      const lines = onResults(null, submittedBody);
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    throw new Error(`routingFetch: unexpected URL ${u}`);
  };
}

// ── payment_required (issue #88) ─────────────────────────────────────────────
//
// The body below is VERBATIM what POST /v1/messages/batches returned on
// 2026-09-02 (request_id req_011CeejUhYyYfutJc9YTHFnd) once the account's
// credit balance hit zero. Before this fix `classifyTransportKind` keyed on
// status alone and answered `transport_error` -- a TRANSIENT class -- so a dry
// account read as "a bad afternoon on the wire" (#8's ledger literally said
// `{transport_error: 20}`) and, post-#90, every cell stayed re-attemptable
// into the same unpayable wall forever.
const CREDIT_EXHAUSTED_400 = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
  request_id: "req_011CeejUhYyYfutJc9YTHFnd",
};

test("issue #88: the real credit-exhaustion 400 classifies payment_required, not transport_error", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => jsonResponse(400, CREDIT_EXHAUSTED_400),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    maxRetries: 2,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "payment_required");
});

test("issue #88: a billing refusal is terminal on the first response -- the backoff ladder is never burned against an account that cannot pay", async () => {
  let calls = 0;
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    // A 429 carrying the credit signature: retryable BY STATUS. The whole
    // point of body-keyed detection is that the body overrules the status.
    fetchImpl: async () => {
      calls++;
      return jsonResponse(429, CREDIT_EXHAUSTED_400);
    },
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    maxRetries: 3,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.failureKind, "payment_required", "the body's signature must outrank the 429 status");
  assert.equal(calls, 1, "a billing refusal must not be retried");
});

test("issue #88: an ordinary 400 (oversized max_tokens) still classifies transport_error -- 400 alone is not the signal", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () =>
      jsonResponse(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: 999999 > 8192" } }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    maxRetries: 0,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.failureKind, "transport_error");
});
