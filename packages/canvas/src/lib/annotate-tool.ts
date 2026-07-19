/**
 * The transient tool state for annotate mode (GP-58, five types as of GP-73).
 *
 * `select` opens the details panel (and note editor) as usual. The rest collect
 * node picks, and they collect them in one of two ways:
 *
 *   - **multi-select** (`group`, `hide`) — a membership set, fed by marquee drag
 *     and shift-click. You are saying something about *these resources*.
 *   - **ordered picks** (`link`, `rename`) — a fixed number of nodes in click
 *     order: two for an edge's source→target, one for the node to rename.
 *
 * Pure, so the click flows are unit-tested without a canvas.
 */
export type AnnotateTool = "select" | "note" | "link" | "group" | "hide" | "rename";

export type ToolState = {
  tool: AnnotateTool;
  /** Node ids picked so far for the active multi-node tool. */
  picks: string[];
};

export const INITIAL_TOOL: ToolState = { tool: "select", picks: [] };

/** Tools whose picks are a set the user builds up (marquee/shift-click). */
const MULTI_SELECT: ReadonlySet<AnnotateTool> = new Set<AnnotateTool>(["group", "hide"]);

/** How many nodes an ordered-pick tool wants before it can be applied. */
const PICK_LIMIT: Partial<Record<AnnotateTool, number>> = { link: 2, rename: 1 };

/** True when this tool builds its picks by selection rather than by click order. */
export function isMultiSelectTool(tool: AnnotateTool): boolean {
  return MULTI_SELECT.has(tool);
}

export type ToolAction =
  | { type: "setTool"; tool: AnnotateTool }
  | { type: "pick"; id: string }
  | { type: "applySelection"; changes: { id: string; selected: boolean }[] }
  | { type: "reset" };

/** Multi-select: a click toggles membership. */
function togglePick(state: ToolState, id: string): ToolState {
  const picks = state.picks.includes(id)
    ? state.picks.filter((p) => p !== id)
    : [...state.picks, id];
  return { ...state, picks };
}

/**
 * Ordered picks: distinct nodes in click order. A repeat click, or one past the
 * tool's limit, is ignored rather than silently replacing what you already chose.
 */
function appendPick(state: ToolState, id: string): ToolState {
  const limit = PICK_LIMIT[state.tool];
  if (limit === undefined) return state; // `select` / `note` ignore picks
  if (state.picks.includes(id) || state.picks.length >= limit) return state;
  return { ...state, picks: [...state.picks, id] };
}

/** Marquee drag: React Flow emits one change per node the box touched. */
function applySelection(
  state: ToolState,
  changes: { id: string; selected: boolean }[],
): ToolState {
  if (!isMultiSelectTool(state.tool)) return state;
  const picks = new Set(state.picks);
  for (const change of changes) {
    if (change.selected) picks.add(change.id);
    else picks.delete(change.id);
  }
  return { ...state, picks: Array.from(picks) };
}

export function reduceTool(state: ToolState, action: ToolAction): ToolState {
  switch (action.type) {
    case "setTool":
      return { tool: action.tool, picks: [] };
    case "reset":
      return { tool: state.tool, picks: [] };
    case "applySelection":
      return applySelection(state, action.changes);
    case "pick":
      return isMultiSelectTool(state.tool)
        ? togglePick(state, action.id)
        : appendPick(state, action.id);
    default:
      return state;
  }
}

/** Has an ordered-pick tool collected everything it needs? */
export function picksAreComplete(state: ToolState): boolean {
  const limit = PICK_LIMIT[state.tool];
  return limit !== undefined && state.picks.length === limit;
}

/** A link is ready to be created once exactly two nodes are picked. */
export function linkIsReady(state: ToolState): boolean {
  return state.tool === "link" && picksAreComplete(state);
}

/** A rename is ready once its one node is picked. */
export function renameIsReady(state: ToolState): boolean {
  return state.tool === "rename" && picksAreComplete(state);
}
