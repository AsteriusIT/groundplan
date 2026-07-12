import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getPublicSnapshot: vi.fn() };
});

vi.mock("@/components/graph-canvas", () => ({
  GraphCanvas: ({ graph }: { graph: { nodes: unknown[] } }) => (
    <div data-testid="canvas">{graph.nodes.length} nodes</div>
  ),
}));

import { ApiError, getPublicSnapshot } from "@/api/client";
import type { PublicSnapshotView } from "@/api/types";
import { SharePage } from "./share-page";

const getPublicSnapshotMock = vi.mocked(getPublicSnapshot);

const view: PublicSnapshotView = {
  kind: "docs_latest",
  repository: { name: "acme/infra", provider: "github" },
  annotations: [],
  snapshot: {
    id: "s1",
    source: "hcl",
    ref: "main",
    commitSha: "2c9f8061abcd",
    createdAt: "2026-07-11T00:00:00.000Z",
    stats: { nodes: 2, edges: 1, changes: { create: 0, update: 0, delete: 0, noop: 2, unchanged: 2 } },
    summaryMd: "No changes.",
    graph: {
      version: 1,
      nodes: [
        { id: "a", name: "a", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null },
        { id: "b", name: "b", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null },
      ],
      edges: [],
    },
  },
};

function renderAt(token = "tok123456789012") {
  return render(
    <MemoryRouter initialEntries={[`/share/${token}`]}>
      <Routes>
        <Route path="/share/:token" element={<SharePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getPublicSnapshotMock.mockReset();
});

it("renders the repo header and the read-only canvas", async () => {
  getPublicSnapshotMock.mockResolvedValue(view);
  renderAt();

  expect(await screen.findByText("acme/infra")).toBeInTheDocument();
  expect(screen.getByText(/main · 2c9f8061/)).toBeInTheDocument();
  expect(await screen.findByTestId("canvas")).toHaveTextContent("2 nodes");
  expect(screen.getByText(/Read-only shared view/)).toBeInTheDocument();
});

it("shows a clean not-found state for a revoked or unknown token", async () => {
  getPublicSnapshotMock.mockRejectedValue(new ApiError(404, "share link not found"));
  renderAt();

  expect(await screen.findByText("Link not available")).toBeInTheDocument();
  expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();
});
