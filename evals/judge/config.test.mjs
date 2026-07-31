// Tests for resolveRhoFloor (issue #4, AC9): no default number is ever baked in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRhoFloor } from "./config.mjs";

test("resolveRhoFloor throws when the floor is entirely unset", () => {
  assert.throws(() => resolveRhoFloor({}), /no rho floor is registered/);
  assert.throws(() => resolveRhoFloor(undefined), /no rho floor is registered/);
});

test("resolveRhoFloor throws when config.judge exists but rhoFloor does not", () => {
  assert.throws(() => resolveRhoFloor({ judge: {} }), /no rho floor is registered/);
});

test("resolveRhoFloor throws on a non-numeric or non-finite floor", () => {
  assert.throws(() => resolveRhoFloor({ judge: { rhoFloor: "0.4" } }), /no rho floor is registered/);
  assert.throws(() => resolveRhoFloor({ judge: { rhoFloor: NaN } }), /no rho floor is registered/);
  assert.throws(() => resolveRhoFloor({ judge: { rhoFloor: Infinity } }), /no rho floor is registered/);
});

test("resolveRhoFloor returns the registered floor when explicitly supplied", () => {
  assert.equal(resolveRhoFloor({ judge: { rhoFloor: 0.4 } }), 0.4);
  assert.equal(resolveRhoFloor({ judge: { rhoFloor: 0 } }), 0, "0 is a valid (if unusual) explicit floor, not treated as unset");
});
