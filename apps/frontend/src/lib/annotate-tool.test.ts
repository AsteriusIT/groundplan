import { describe, expect, it } from "vitest";

import { INITIAL_TOOL, linkIsReady, reduceTool } from "./annotate-tool";

describe("reduceTool", () => {
  it("selecting a tool resets any in-progress picks", () => {
    const picked = reduceTool(INITIAL_TOOL, { type: "pick", id: "a" });
    const switched = reduceTool({ ...picked, tool: "link" }, { type: "setTool", tool: "group" });
    expect(switched).toEqual({ tool: "group", picks: [] });
  });

  it("the link tool collects two distinct nodes in click order", () => {
    let state = reduceTool(INITIAL_TOOL, { type: "setTool", tool: "link" });
    state = reduceTool(state, { type: "pick", id: "a" });
    state = reduceTool(state, { type: "pick", id: "a" }); // same node ignored
    state = reduceTool(state, { type: "pick", id: "b" });
    expect(state.picks).toEqual(["a", "b"]);
    expect(linkIsReady(state)).toBe(true);
  });

  it("the group tool toggles membership", () => {
    let state = reduceTool(INITIAL_TOOL, { type: "setTool", tool: "group" });
    state = reduceTool(state, { type: "pick", id: "a" });
    state = reduceTool(state, { type: "pick", id: "b" });
    state = reduceTool(state, { type: "pick", id: "a" }); // toggles off
    expect(state.picks).toEqual(["b"]);
    expect(linkIsReady(state)).toBe(false);
  });

  it("the select tool ignores picks", () => {
    const state = reduceTool(INITIAL_TOOL, { type: "pick", id: "a" });
    expect(state.picks).toEqual([]);
  });

  it("reset clears picks but keeps the active tool", () => {
    let state = reduceTool(INITIAL_TOOL, { type: "setTool", tool: "link" });
    state = reduceTool(state, { type: "pick", id: "a" });
    state = reduceTool(state, { type: "reset" });
    expect(state).toEqual({ tool: "link", picks: [] });
  });
});
