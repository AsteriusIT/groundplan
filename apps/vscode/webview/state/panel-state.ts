/**
 * What the reader chose about this panel — the lens, the diff preferences and
 * whether the diagram follows the cursor. Deliberately *not* what the host
 * reported: whether a baseline resolved, which ref it is and whether the diff
 * came back clean are facts, they arrive by message, and mixing them into the
 * same object is how a control ends up claiming something the workspace never
 * said (see `DiffState` in ../../src/messages).
 *
 * One reducer, so every piece of chrome reads the same panel.
 */
import type { BaselineMode, DiffState } from "../../src/messages";
import { ALL_FILTERS, CATEGORY_META, type Category } from "@groundplan/canvas";

import type { PanelPrefs } from "../../src/panel-prefs";
import { NO_EXCLUSIONS, type FilterExclusions } from "./filters";

/** `infra` is labelled "Global" — the key is the web app's `?view=infra`. */
export type Lens = "infra" | "network" | "iam";

/** The three diff choices the host persists per workspace. */
export type DiffPrefs = {
  enabled: boolean;
  mode: BaselineMode;
  changedOnly: boolean;
};

/**
 * What the host observed about the diff, as opposed to what the reader chose.
 * Whether a baseline resolved, which ref it is, why it did not and whether the
 * diff came back clean are facts about the workspace: they arrive by message,
 * and no control may assert one on its own.
 */
export type DiffFacts = Pick<
  DiffState,
  "available" | "ref" | "sha" | "reason" | "clean"
>;

export const NO_DIFF_FACTS: DiffFacts = {
  available: false,
  ref: null,
  sha: null,
  reason: null,
  clean: false,
};

export type PanelState = {
  lens: Lens;
  diff: DiffPrefs;
  /** What is being filtered *out* — see ./filters for why that way round. */
  filters: FilterExclusions;
  followCursor: boolean;
};

export type PanelAction =
  | { type: "setLens"; lens: Lens }
  | { type: "toggleDiff" }
  | { type: "setBase"; mode: BaselineMode }
  | { type: "toggleChangedOnly" }
  | { type: "toggleFollowCursor" }
  | { type: "setFilters"; filters: FilterExclusions }
  | { type: "clearFilters" }
  /** The whole document, restored by the host when the panel says it is ready. */
  | { type: "hostPanelPrefs"; prefs: PanelPrefs }
  /** The host's persisted preferences, echoed back with every snapshot. */
  | { type: "hostDiffPrefs"; prefs: DiffPrefs };

export const INITIAL_PANEL_STATE: PanelState = {
  lens: "infra",
  diff: { enabled: false, mode: "head", changedOnly: false },
  filters: NO_EXCLUSIONS,
  followCursor: true,
};

function samePrefs(a: DiffPrefs, b: DiffPrefs): boolean {
  return (
    a.enabled === b.enabled &&
    a.mode === b.mode &&
    a.changedOnly === b.changedOnly
  );
}

export function panelReducer(
  state: PanelState,
  action: PanelAction,
): PanelState {
  switch (action.type) {
    case "setLens":
      return state.lens === action.lens ? state : { ...state, lens: action.lens };

    case "toggleDiff":
      return { ...state, diff: { ...state.diff, enabled: !state.diff.enabled } };

    case "setBase":
      return state.diff.mode === action.mode
        ? state
        : { ...state, diff: { ...state.diff, mode: action.mode } };

    case "toggleChangedOnly":
      // Nothing to fold without a diff, and a preference set from nowhere
      // would apply itself the next time diff mode came on.
      if (!state.diff.enabled) return state;
      return {
        ...state,
        diff: { ...state.diff, changedOnly: !state.diff.changedOnly },
      };

    case "toggleFollowCursor":
      return { ...state, followCursor: !state.followCursor };

    case "setFilters":
      return { ...state, filters: action.filters };

    case "clearFilters":
      // Identity when nothing was filtered: the chips row is not rendered at
      // all in that state, so a "clear" that re-renders the panel is churn.
      return state.filters === NO_EXCLUSIONS
        ? state
        : { ...state, filters: NO_EXCLUSIONS };

    case "hostPanelPrefs":
      return fromPanelPrefs(action.prefs);

    case "hostDiffPrefs":
      // Identity matters: this arrives with every post, and a fresh object per
      // keystroke would re-render the panel and remount the canvas.
      return samePrefs(state.diff, action.prefs)
        ? state
        : { ...state, diff: action.prefs };
  }
}

/**
 * The state as the host stores it. Sets do not survive JSON, and the filters
 * are exclusions on purpose — see ./filters.
 */
export function toPanelPrefs(state: PanelState): PanelPrefs {
  return {
    version: 1,
    lens: state.lens,
    diff: { ...state.diff },
    filters: {
      change: [...state.filters.change],
      categories: [...state.filters.categories],
      modules: [...state.filters.modules],
      hubEdges: state.filters.hubEdges,
    },
    followCursor: state.followCursor,
  };
}

/**
 * And back. The host validated the document's *shape*; the two enumerated
 * filter sets are narrowed here instead of cast, because a stored string that
 * is no longer a change kind or a category should exclude nothing rather than
 * become one by assertion. Module names are free-form and need no narrowing —
 * one that no longer exists already excludes nothing (see ./filters).
 */
export function fromPanelPrefs(prefs: PanelPrefs): PanelState {
  const stored = new Set(prefs.filters.change);
  const storedCategories = new Set<string>(prefs.filters.categories);
  return {
    lens: prefs.lens,
    diff: { ...prefs.diff },
    filters: {
      change: new Set(ALL_FILTERS.filter((key) => stored.has(key))),
      categories: new Set(
        (Object.keys(CATEGORY_META) as Category[]).filter((category) =>
          storedCategories.has(category),
        ),
      ),
      modules: new Set(prefs.filters.modules),
      hubEdges: prefs.filters.hubEdges,
    },
    followCursor: prefs.followCursor,
  };
}
