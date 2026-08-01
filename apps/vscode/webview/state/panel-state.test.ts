/**
 * The panel's own state: what the reader chose, as opposed to what the host
 * reported. One reducer so every control reads the same object and no two
 * pieces of chrome can describe different panels.
 */
import { describe, expect, test } from "vitest";

import { NO_EXCLUSIONS } from "./filters";
import {
  INITIAL_PANEL_STATE,
  fromPanelPrefs,
  panelReducer,
  toPanelPrefs,
  type PanelState,
} from "./panel-state";

describe("panelReducer", () => {
  test("starts on the global lens with diff off and follow-cursor on", () => {
    expect(INITIAL_PANEL_STATE).toEqual({
      lens: "infra",
      diff: { enabled: false, mode: "head", changedOnly: false },
      filters: NO_EXCLUSIONS,
      followCursor: true,
    });
  });

  test("setLens switches lens", () => {
    const next = panelReducer(INITIAL_PANEL_STATE, {
      type: "setLens",
      lens: "network",
    });

    expect(next.lens).toBe("network");
  });

  test("toggleDiff flips diff mode", () => {
    const on = panelReducer(INITIAL_PANEL_STATE, { type: "toggleDiff" });
    expect(on.diff.enabled).toBe(true);

    const off = panelReducer(on, { type: "toggleDiff" });
    expect(off.diff.enabled).toBe(false);
  });

  test("setBase changes the baseline", () => {
    const next = panelReducer(INITIAL_PANEL_STATE, {
      type: "setBase",
      mode: "merge-base",
    });

    expect(next.diff.mode).toBe("merge-base");
  });

  test("toggleChangedOnly folds the graph while diff mode is on", () => {
    const on = panelReducer(INITIAL_PANEL_STATE, { type: "toggleDiff" });

    const folded = panelReducer(on, { type: "toggleChangedOnly" });

    expect(folded.diff.changedOnly).toBe(true);
  });

  test("toggleChangedOnly is refused while diff mode is off", () => {
    // "Changed only" folds a diff. With no diff there is nothing to fold, and
    // a preference set from nowhere would silently apply the next time diff
    // came on — so the reducer refuses it, not just the UI.
    const next = panelReducer(INITIAL_PANEL_STATE, { type: "toggleChangedOnly" });

    expect(next.diff.changedOnly).toBe(false);
    expect(next).toBe(INITIAL_PANEL_STATE);
  });

  test("turning diff off keeps the changed-only choice for next time", () => {
    let state = panelReducer(INITIAL_PANEL_STATE, { type: "toggleDiff" });
    state = panelReducer(state, { type: "toggleChangedOnly" });

    const off = panelReducer(state, { type: "toggleDiff" });

    expect(off.diff.enabled).toBe(false);
    expect(off.diff.changedOnly).toBe(true);
  });

  test("toggleFollowCursor flips following", () => {
    const next = panelReducer(INITIAL_PANEL_STATE, { type: "toggleFollowCursor" });

    expect(next.followCursor).toBe(false);
  });

  test("the host's echo replaces the local diff preferences", () => {
    // The host persists and echoes; when the two differ the host wins, or a
    // panel reopened against a different workspace would show stale choices.
    const next = panelReducer(INITIAL_PANEL_STATE, {
      type: "hostDiffPrefs",
      prefs: { enabled: true, mode: "merge-base", changedOnly: true },
    });

    expect(next.diff).toEqual({
      enabled: true,
      mode: "merge-base",
      changedOnly: true,
    });
  });

  test("an echo that changes nothing leaves the state identical", () => {
    // Every host post carries diffState; a new object each time would re-render
    // the whole panel — and remount the canvas — on every keystroke.
    const next = panelReducer(INITIAL_PANEL_STATE, {
      type: "hostDiffPrefs",
      prefs: { enabled: false, mode: "head", changedOnly: false },
    });

    expect(next).toBe(INITIAL_PANEL_STATE);
  });

  test("setFilters records what is being hidden", () => {
    const next = panelReducer(INITIAL_PANEL_STATE, {
      type: "setFilters",
      filters: { ...NO_EXCLUSIONS, change: new Set(["create"]) },
    });

    expect([...next.filters.change]).toEqual(["create"]);
  });

  test("clearFilters puts the whole diagram back", () => {
    const filtered = panelReducer(INITIAL_PANEL_STATE, {
      type: "setFilters",
      filters: { ...NO_EXCLUSIONS, change: new Set(["create"]), hubEdges: true },
    });

    const cleared = panelReducer(filtered, { type: "clearFilters" });

    expect(cleared.filters).toEqual(NO_EXCLUSIONS);
  });

  test("clearing filters that are already clear changes nothing", () => {
    const next = panelReducer(INITIAL_PANEL_STATE, { type: "clearFilters" });

    expect(next).toBe(INITIAL_PANEL_STATE);
  });
});

describe("persistence", () => {
  test("what the panel remembers survives a round trip", () => {
    const state: PanelState = {
      lens: "network",
      diff: { enabled: true, mode: "merge-base", changedOnly: true },
      filters: {
        change: new Set(["create"]),
        categories: new Set(["compute"]),
        modules: new Set(["net"]),
        hubEdges: true,
      },
      followCursor: false,
    };

    expect(fromPanelPrefs(toPanelPrefs(state))).toEqual(state);
  });

  test("the sets come back as sets, not as the arrays they were stored as", () => {
    const restored = fromPanelPrefs({
      version: 1,
      lens: "infra",
      diff: { enabled: false, mode: "head", changedOnly: false },
      filters: {
        change: ["delete"],
        categories: [],
        modules: [],
        hubEdges: false,
      },
      followCursor: true,
    });

    expect(restored.filters.change).toBeInstanceOf(Set);
    expect(restored.filters.change.has("delete")).toBe(true);
  });

  test("the host's document replaces the panel's state wholesale", () => {
    const next = panelReducer(INITIAL_PANEL_STATE, {
      type: "hostPanelPrefs",
      prefs: {
        version: 1,
        lens: "iam",
        diff: { enabled: true, mode: "head", changedOnly: false },
        filters: { change: [], categories: [], modules: [], hubEdges: false },
        followCursor: false,
      },
    });

    expect(next.lens).toBe("iam");
    expect(next.followCursor).toBe(false);
  });
});
