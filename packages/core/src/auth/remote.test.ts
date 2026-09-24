/**
 * Every spelling of one remote must collapse to one key. Core used to match raw strings, so a
 * dashboard connect and a CLI connect on the same repository produced two rows and split the graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRemote } from "./remote.js";

test("all the ways a client can spell one repo collapse to one key", () => {
  const canonical = "github.com/naman7474/credit-card-be";
  for (const spelling of [
    "github.com/naman7474/credit-card-be",
    "https://github.com/naman7474/credit-card-be.git",
    "https://github.com/naman7474/credit-card-be",
    "http://github.com/naman7474/credit-card-be.git",
    "git@github.com:naman7474/credit-card-be.git",
    "ssh://git@github.com/naman7474/credit-card-be.git",
    "https://token@github.com/naman7474/credit-card-be.git",
    "  https://github.com/naman7474/credit-card-be.git/  ",
  ]) {
    assert.equal(normalizeRemote(spelling), canonical, spelling);
  }
});

test("genuinely different repositories stay different", () => {
  assert.notEqual(
    normalizeRemote("https://github.com/naman7474/credit-card-be.git"),
    normalizeRemote("https://github.com/lockstep-pulse-hq/credit-card-be.git"),
  );
  assert.equal(normalizeRemote("gitlab.com/acme/api"), "gitlab.com/acme/api");
});
