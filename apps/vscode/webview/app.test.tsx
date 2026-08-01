/**
 * The panel as a whole, mounted the way the host drives it: by message.
 *
 * The canvas is stubbed. What is under test here is the chrome — which zone
 * owns what, and what is no longer permanently on screen — and mounting ELK
 * and React Flow to assert that a caption is absent would test the diagram
 * instead. `packages/canvas` has its own tests for the drawing.
 */
import { describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
  sha: "a1b2c3d4e5f6",
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

describe("the status bar", () => {
  test("dates the comparison: which ref, which commit", () => {
    // A diagram read as live when it is a comparison against an old commit is
    // the one failure this bar exists to prevent.
    mount([node("a", "update")], { ...CLEAN, clean: false });

    expect(screen.getByText("origin/main")).toBeInTheDocument();
    expect(screen.getByText("a1b2c3d")).toBeInTheDocument();
  });

  test("reports what the host says about freshness", () => {
    mount([node("a", "noop")]);

    fromHost({ type: "sync", value: "rendering" });

    expect(screen.getByRole("status")).toHaveTextContent(/rendering/i);
  });

  test("an out-of-sync parse is reported in the bar, not over the diagram", () => {
    mount([node("a", "noop")]);

    fromHost({ type: "outOfSync", value: true });

    // Still said — moved, not dropped.
    expect(screen.getByText(/out of sync/i)).toBeInTheDocument();
    // And no longer a chip pinned to the corner of the drawing.
    expect(screen.getByText(/out of sync/i).closest("[class*='absolute']")).toBeNull();
  });

  test("a multi-root workspace is an aside, not a banner across the diagram", () => {
    const post = vi.fn();
    render(<App post={post} />);
    fromHost({
      type: "snapshot",
      snapshot: graph([node("a", "noop")]),
      folder: "infra",
      multiRoot: true,
      rootDir: "",
    });

    const notice = screen.getByText(/first of several workspace folders/i);
    expect(notice).toBeInTheDocument();
    expect(notice.closest("[class*='absolute']")).toBeNull();
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

describe("the chrome the canvas gave up", () => {
  test("search is a toolbar control, folded away until asked for", () => {
    mount([node("a", "noop")]);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /search resources/i }));

    expect(screen.getByLabelText(/search resources/i)).toBeInTheDocument();
  });

  test("the legend explains only what is on the diagram", () => {
    mount([node("a", "create"), node("b", "noop")], { ...CLEAN, clean: false });

    fireEvent.click(screen.getByRole("button", { name: /^legend$/i }));

    const legend = screen.getByRole("dialog", { name: /legend/i });
    expect(within(legend).getByText(/create/i)).toBeInTheDocument();
    // Nothing was deleted, so there is no delete swatch to explain.
    expect(within(legend).queryByText(/^delete$/i)).not.toBeInTheDocument();
  });

  test("zoom sits on the diagram, where zooming happens", () => {
    mount([node("a", "noop")]);

    expect(screen.getByRole("button", { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /zoom out/i })).toBeInTheDocument();
  });

  test("fit means fit the changes once there are changes to fit", () => {
    mount([node("a", "create")], { ...CLEAN, clean: false });

    expect(screen.getByRole("button", { name: /fit the changes/i })).toBeInTheDocument();
  });

  test("fit means fit the diagram when nothing is being compared", () => {
    mount([node("a", "noop")]);

    expect(screen.getByRole("button", { name: /fit the diagram/i })).toBeInTheDocument();
  });
});

describe("filters", () => {
  test("no chips row at all while nothing is filtered", () => {
    mount([node("a", "noop")]);

    expect(screen.queryByRole("button", { name: /stop hiding/i })).not.toBeInTheDocument();
  });

  test("hiding something puts a chip on screen saying so", () => {
    // A filter panel you closed is a filter you forgot; the diagram would show
    // less than the workspace holds with nothing on screen admitting it.
    mount([node("a", "create")], { ...CLEAN, clean: false });

    fireEvent.click(screen.getByRole("button", { name: /^filters$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Create/ }));

    expect(screen.getByRole("button", { name: /stop hiding create/i })).toBeInTheDocument();
  });

  test("the filter icon counts what is hidden", () => {
    mount([node("a", "create")], { ...CLEAN, clean: false });

    fireEvent.click(screen.getByRole("button", { name: /^filters$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Create/ }));

    expect(screen.getByRole("button", { name: /^filters$/i })).toHaveTextContent("1");
  });

  test("a chip puts back exactly what it was hiding", () => {
    mount([node("a", "create")], { ...CLEAN, clean: false });
    fireEvent.click(screen.getByRole("button", { name: /^filters$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Create/ }));

    fireEvent.click(screen.getByRole("button", { name: /stop hiding create/i }));

    expect(screen.queryByRole("button", { name: /stop hiding/i })).not.toBeInTheDocument();
  });

  test("filtering is the panel's own business", () => {
    // It is a fold of the snapshot in hand — no reason to make the host parse
    // anything again.
    const { post } = mount([node("a", "create")], { ...CLEAN, clean: false });
    post.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^filters$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Create/ }));

    expect(post).not.toHaveBeenCalled();
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
