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
import type { BaselineMode } from "../../src/messages";

/** `infra` is labelled "Global" — the key is the web app's `?view=infra`. */
export type Lens = "infra" | "network" | "iam";

/** The three diff choices the host persists per workspace. */
export type DiffPrefs = {
  enabled: boolean;
  mode: BaselineMode;
  changedOnly: boolean;
};

export type PanelState = {
  lens: Lens;
  diff: DiffPrefs;
  followCursor: boolean;
};

export type PanelAction =
  | { type: "setLens"; lens: Lens }
  | { type: "toggleDiff" }
  | { type: "setBase"; mode: BaselineMode }
  | { type: "toggleChangedOnly" }
  | { type: "toggleFollowCursor" }
  /** The host's persisted preferences, echoed back with every snapshot. */
  | { type: "hostDiffPrefs"; prefs: DiffPrefs };

export const INITIAL_PANEL_STATE: PanelState = {
  lens: "infra",
  diff: { enabled: false, mode: "head", changedOnly: false },
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

    case "hostDiffPrefs":
      // Identity matters: this arrives with every post, and a fresh object per
      // keystroke would re-render the panel and remount the canvas.
      return samePrefs(state.diff, action.prefs)
        ? state
        : { ...state, diff: action.prefs };
  }
}
