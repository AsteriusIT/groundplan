/**
 * The transient tool state for annotate mode (GP-58). `select` opens the details
 * panel (and note editor) as usual; `link` collects two distinct nodes in click
 * order; `group` toggles a membership set. Pure so the click flows are unit-tested.
 */
export type AnnotateTool = "select" | "note" | "link" | "group";

export type ToolState = {
  tool: AnnotateTool;
  /** Node ids picked so far for the active multi-node tool (link/group). */
  picks: string[];
};

export const INITIAL_TOOL: ToolState = { tool: "select", picks: [] };

export type ToolAction =
  | { type: "setTool"; tool: AnnotateTool }
  | { type: "pick"; id: string }
  | { type: "reset" };

export function reduceTool(state: ToolState, action: ToolAction): ToolState {
  switch (action.type) {
    case "setTool":
      return { tool: action.tool, picks: [] };
    case "reset":
      return { tool: state.tool, picks: [] };
    case "pick": {
      if (state.tool === "link") {
        // Two distinct nodes in click order; a repeat click is ignored.
        if (state.picks.includes(action.id) || state.picks.length >= 2) {
          return state;
        }
        return { ...state, picks: [...state.picks, action.id] };
      }
      if (state.tool === "group") {
        const has = state.picks.includes(action.id);
        return {
          ...state,
          picks: has
            ? state.picks.filter((p) => p !== action.id)
            : [...state.picks, action.id],
        };
      }
      return state;
    }
    default:
      return state;
  }
}

/** A link is ready to be created once exactly two nodes are picked. */
export function linkIsReady(state: ToolState): boolean {
  return state.tool === "link" && state.picks.length === 2;
}
