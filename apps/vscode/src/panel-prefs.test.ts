/**
 * What survives closing the panel, and what happens when what was stored no
 * longer makes sense. A preference that cannot be read must never be worse
 * than one that was never written.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PANEL_PREFS,
  needsRefresh,
  parsePanelPrefs,
  type PanelPrefs,
} from "./panel-prefs";

const LEGACY = { enabled: true, mode: "merge-base" as const, changedOnly: true };

test("nothing stored yet gives the quiet defaults", () => {
  const prefs = parsePanelPrefs(undefined, {
    enabled: false,
    mode: "head",
    changedOnly: false,
  });

  assert.deepEqual(prefs, DEFAULT_PANEL_PREFS);
});

test("the diff choices already persisted are adopted, not discarded", () => {
  // GP-154 stored three keys of its own. A reader who had diff mode on
  // yesterday should not find it off today because the storage moved.
  const prefs = parsePanelPrefs(undefined, LEGACY);

  assert.deepEqual(prefs.diff, LEGACY);
});

test("a full round trip returns what went in", () => {
  const stored: PanelPrefs = {
    version: 1,
    lens: "network",
    diff: { enabled: true, mode: "head", changedOnly: false },
    filters: {
      change: ["create"],
      categories: ["compute"],
      modules: ["net"],
      hubEdges: true,
    },
    followCursor: false,
  };

  assert.deepEqual(parsePanelPrefs(JSON.parse(JSON.stringify(stored)), LEGACY), stored);
});

test("a state written by a future version is ignored, not half-read", () => {
  const prefs = parsePanelPrefs({ version: 99, lens: "iam" }, LEGACY);

  assert.equal(prefs.lens, DEFAULT_PANEL_PREFS.lens);
});

test("junk in storage is ignored rather than thrown over", () => {
  for (const junk of [null, 42, "state", [], { lens: 7 }]) {
    const prefs = parsePanelPrefs(junk, LEGACY);
    assert.equal(prefs.lens, "infra");
  }
});

test("a lens that is not one of ours falls back", () => {
  const prefs = parsePanelPrefs({ version: 1, lens: "galaxy" }, LEGACY);

  assert.equal(prefs.lens, "infra");
});

test("a baseline that is not one of ours falls back", () => {
  const prefs = parsePanelPrefs(
    { version: 1, diff: { enabled: true, mode: "yesterday", changedOnly: false } },
    LEGACY,
  );

  assert.equal(prefs.diff.mode, "head");
});

test("a partially written state keeps the parts that read", () => {
  const prefs = parsePanelPrefs({ version: 1, lens: "iam" }, LEGACY);

  assert.equal(prefs.lens, "iam");
  assert.equal(prefs.followCursor, true);
});

test("filter exclusions survive, since that is the point of storing them", () => {
  const prefs = parsePanelPrefs(
    {
      version: 1,
      filters: { change: ["delete"], categories: [], modules: ["net"], hubEdges: false },
    },
    LEGACY,
  );

  assert.deepEqual(prefs.filters.change, ["delete"]);
  assert.deepEqual(prefs.filters.modules, ["net"]);
});

test("a filter list of the wrong shape drops to hiding nothing", () => {
  // Failing towards "show everything" is the whole reason exclusions are what
  // gets stored: the alternative hides resources nobody can restore.
  const prefs = parsePanelPrefs(
    { version: 1, filters: { change: "delete", categories: 3, modules: null } },
    LEGACY,
  );

  assert.deepEqual(prefs.filters, DEFAULT_PANEL_PREFS.filters);
});

test("follow-cursor is on until somebody turns it off", () => {
  assert.equal(DEFAULT_PANEL_PREFS.followCursor, true);
  assert.equal(parsePanelPrefs({ version: 1, followCursor: false }, LEGACY).followCursor, false);
});

// --- what actually costs a re-render --------------------------------------

const BASE: PanelPrefs = {
  version: 1,
  lens: "infra",
  diff: { enabled: false, mode: "head", changedOnly: false },
  filters: { change: [], categories: [], modules: [], hubEdges: false },
  followCursor: true,
};

test("switching lens costs the host nothing", () => {
  // A lens is a fold of the snapshot the panel already holds. Re-parsing for
  // it would be a round trip to redraw what is already on screen.
  assert.equal(needsRefresh(BASE, { ...BASE, lens: "network" }), false);
});

test("filtering costs the host nothing either", () => {
  assert.equal(
    needsRefresh(BASE, {
      ...BASE,
      filters: { ...BASE.filters, change: ["create"] },
    }),
    false,
  );
});

test("follow-cursor costs the host nothing to redraw", () => {
  assert.equal(needsRefresh(BASE, { ...BASE, followCursor: false }), false);
});

test("turning diff on needs the graph annotated", () => {
  assert.equal(
    needsRefresh(BASE, { ...BASE, diff: { ...BASE.diff, enabled: true } }),
    true,
  );
});

test("changing the baseline needs a different comparison", () => {
  assert.equal(
    needsRefresh(BASE, { ...BASE, diff: { ...BASE.diff, mode: "merge-base" } }),
    true,
  );
});

test("changed-only needs the fold recomputed", () => {
  assert.equal(
    needsRefresh(BASE, { ...BASE, diff: { ...BASE.diff, changedOnly: true } }),
    true,
  );
});

test("preferences that did not move need nothing", () => {
  assert.equal(needsRefresh(BASE, { ...BASE }), false);
});
