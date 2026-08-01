/**
 * The panel as a whole, mounted the way the host drives it: by message.
 *
 * The canvas is stubbed. What is under test here is the chrome — which zone
 * owns what, and what is no longer permanently on screen — and mounting ELK
 * and React Flow to assert that a caption is absent would test the diagram
 * instead. `packages/canvas` has its own tests for the drawing.
 */
import { describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ChangeKind, Graph, GraphNode } from "@groundplan/graph-parser";

import type { DiffState, HostMessage } from "../src/messages";

vi.mock("@groundplan/canvas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@groundplan/canvas")>()),
  GraphCanvas: () => <div data-testid="canvas" />,
  IamTable: () => <div data-testid="iam-table" />,
}));

const { App } = await import("./app");

function node(id: string, change: ChangeKind | null): GraphNode {
  return {
    id,
    name: id,
    type: "azurerm_storage_account",
    provider: "azurerm",
    module_path: [],
    change,
  };
}

function graph(nodes: GraphNode[]): Graph {
  return { version: 2, nodes, edges: [] };
}

const CLEAN: DiffState = {
  enabled: true,
  mode: "merge-base",
  changedOnly: false,
  available: true,
  ref: "origin/main",
  reason: null,
  clean: true,
};

/** Deliver a host message the way the webview really receives one. */
function fromHost(message: HostMessage): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  });
}

function mount(nodes: GraphNode[], diff?: DiffState) {
  const post = vi.fn();
  render(<App post={post} />);
  fromHost({
    type: "snapshot",
    snapshot: graph(nodes),
    folder: "infra",
    multiRoot: false,
    rootDir: "",
  });
  if (diff) fromHost({ type: "diffState", state: diff });
  return { post };
}

describe("the canvas is clear", () => {
  test("a clean diff no longer pins a pill to the diagram", () => {
    // It said "No changes vs origin/main", permanently, in the middle of the
    // drawing. The Diff button says the same thing in the space it already
    // occupies.
    mount([node("a", "noop")], CLEAN);

    expect(screen.queryByText(/no changes vs/i)).not.toBeInTheDocument();
  });

  test("the 'not a plan' caveat is no longer pinned to the diagram", () => {
    mount([node("a", "update")], { ...CLEAN, clean: false });

    expect(screen.queryByText(/not a plan: no state/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  test("the caveat is still one click away", () => {
    // Removed from the canvas, not removed from the product: a reader who
    // wants to know what this diff is can still ask.
    mount([node("a", "update")], { ...CLEAN, clean: false });

    fireEvent.click(screen.getByRole("button", { name: /diff options/i }));

    expect(screen.getByText(/not a Terraform plan/i)).toBeInTheDocument();
  });
});

describe("the diff button carries the counts", () => {
  test("a clean diff reads as clean", () => {
    mount([node("a", "noop"), node("b", "noop")], CLEAN);

    expect(screen.getByLabelText("No changes")).toBeInTheDocument();
  });

  test("a change set is counted on the button", () => {
    mount(
      [node("a", "create"), node("b", "create"), node("c", "delete")],
      { ...CLEAN, clean: false },
    );

    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
  });

  test("no baseline means no counts, and says so", () => {
    mount([node("a", "create")], {
      ...CLEAN,
      available: false,
      ref: null,
      reason: "no commits yet",
      clean: false,
    });

    expect(screen.getByLabelText("No baseline")).toBeInTheDocument();
    expect(screen.queryByText("+1")).not.toBeInTheDocument();
  });
});

describe("talking to the host", () => {
  test("turning diff on asks the host to re-render, once", () => {
    const { post } = mount([node("a", "noop")]);
    post.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^diff$/i }));

    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "setDiffPrefs",
      enabled: true,
      mode: "head",
      changedOnly: false,
    });
  });

  test("switching lens is the panel's own business", () => {
    // A lens is a fold of the snapshot already in hand. Asking the host would
    // mean a round trip and a re-parse for a view it already sent.
    const { post } = mount([node("a", "noop")]);
    post.mockClear();

    fireEvent.click(screen.getByRole("radio", { name: "Network" }));

    expect(post).not.toHaveBeenCalled();
  });
});
