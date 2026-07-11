import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getSnapshot: vi.fn(), diffSnapshots: vi.fn() };
});

// The canvas is exercised elsewhere; capture the graph it receives.
vi.mock("@/components/graph-canvas", () => ({
  GraphCanvas: ({ graph }: { graph: { nodes: unknown[] } }) => (
    <div data-testid="canvas">{graph.nodes.length} nodes</div>
  ),
}));

import { diffSnapshots, getSnapshot } from "@/api/client";
import type { Snapshot, SnapshotDiff } from "@/api/types";
import { CompareView } from "./compare-view";

const getSnapshotMock = vi.mocked(getSnapshot);
const diffSnapshotsMock = vi.mocked(diffSnapshots);

const targetSnapshot: Snapshot = {
  id: "s1",
  repositoryId: "r1",
  source: "hcl",
  ref: "main",
  commitSha: "a4e2b77f",
  prNumber: null,
  createdAt: "2026-07-15T00:00:00.000Z",
  stats: { nodes: 2, edges: 0, changes: { create: 0, update: 0, delete: 0, noop: 2, unchanged: 2 } },
  summaryMd: "No changes.",
  graph: {
    version: 1,
    nodes: [
      { id: "azurerm_subnet.a", name: "a", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null },
      { id: "azurerm_subnet.b", name: "b", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null },
    ],
    edges: [],
  },
};

const diff: SnapshotDiff = {
  base: { id: "s0", commitSha: "2c9f8061", createdAt: "2026-07-11T00:00:00.000Z" },
  target: { id: "s1", commitSha: "a4e2b77f", createdAt: "2026-07-15T00:00:00.000Z" },
  added: [{ id: "azurerm_subnet.b", name: "b", type: "azurerm_subnet", module_path: [] }],
  removed: [{ id: "azurerm_subnet.old", name: "old", type: "azurerm_subnet", module_path: [] }],
  moved: [],
  unchangedCount: 1,
};

beforeEach(() => {
  getSnapshotMock.mockReset().mockResolvedValue(targetSnapshot);
  diffSnapshotsMock.mockReset().mockResolvedValue(diff);
});

it("shows the diff summary and renders the compare graph", async () => {
  render(<CompareView baseId="s0" targetId="s1" onExit={() => {}} />);

  expect(await screen.findByText("+1 added")).toBeInTheDocument();
  expect(screen.getByText("−1 removed")).toBeInTheDocument();
  // since 2c9f8061 → a4e2b77f
  expect(screen.getByText(/2c9f8061/)).toBeInTheDocument();
  expect(screen.getByText(/a4e2b77f/)).toBeInTheDocument();
  // The compare graph = 2 target nodes + 1 removed ghost = 3.
  expect(await screen.findByTestId("canvas")).toHaveTextContent("3 nodes");
});

it("exits compare on request", async () => {
  const onExit = vi.fn();
  render(<CompareView baseId="s0" targetId="s1" onExit={onExit} />);
  fireEvent.click(await screen.findByRole("button", { name: /exit compare/i }));
  expect(onExit).toHaveBeenCalled();
});

it("shows a no-differences state for identical snapshots", async () => {
  diffSnapshotsMock.mockResolvedValue({ ...diff, added: [], removed: [], moved: [] });
  render(<CompareView baseId="s0" targetId="s1" onExit={() => {}} />);
  expect(await screen.findByText(/No differences/i)).toBeInTheDocument();
});
