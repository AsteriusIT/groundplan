import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getRepository: vi.fn(),
    listSnapshots: vi.fn(),
    getSnapshot: vi.fn(),
    generateDocs: vi.fn(),
    diffSnapshots: vi.fn(),
  };
});

vi.mock("@/components/graph-canvas", () => ({
  GraphCanvas: ({ graph, variant }: { graph: { nodes: unknown[] }; variant: string }) => (
    <div data-testid="canvas" data-variant={variant}>
      {graph.nodes.length} nodes
    </div>
  ),
}));

import {
  ApiError,
  diffSnapshots,
  generateDocs,
  getRepository,
  getSnapshot,
  listSnapshots,
} from "@/api/client";
import type { Repository, Snapshot, SnapshotDiff, SnapshotSummary } from "@/api/types";
import { DocsPage } from "./docs-page";

const getRepositoryMock = vi.mocked(getRepository);
const listSnapshotsMock = vi.mocked(listSnapshots);
const getSnapshotMock = vi.mocked(getSnapshot);
const generateDocsMock = vi.mocked(generateDocs);
const diffSnapshotsMock = vi.mocked(diffSnapshots);

const repo: Repository = {
  id: "r1",
  projectId: "p1",
  provider: "github",
  url: "https://github.com/acme/infra",
  defaultBranch: "main",
  accessToken: null,
  connectionStatus: "ok",
  verifiedAt: null,
  prCommentsEnabled: false,
  lastCommentError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const baseStats = {
  nodes: 1,
  edges: 0,
  changes: { create: 0, update: 0, delete: 0, noop: 0, unchanged: 1 },
};

function summary(
  id: string,
  commitSha: string,
  trigger: "manual" | "auto",
): SnapshotSummary {
  return {
    id,
    repositoryId: "r1",
    source: "hcl",
    ref: "main",
    commitSha,
    prNumber: null,
    createdAt: "2026-01-03T00:00:00.000Z",
    stats: { ...baseStats, trigger },
  };
}

function snapshot(id: string, nodeCount: number): Snapshot {
  return {
    ...summary(id, `${id}sha`, "manual"),
    summaryMd: "No changes.",
    graph: {
      version: 1,
      nodes: Array.from({ length: nodeCount }, (_, i) => ({
        id: `n${i}`,
        name: `n${i}`,
        type: "aws_s3_bucket",
        provider: "aws",
        module_path: [],
        change: null,
      })),
      edges: [],
    },
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/p1/repos/r1/docs"]}>
      <Routes>
        <Route path="/projects/:id/repos/:repoId/docs" element={<DocsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getRepositoryMock.mockReset().mockResolvedValue(repo);
  listSnapshotsMock.mockReset();
  getSnapshotMock.mockReset().mockImplementation((id: string) =>
    Promise.resolve(snapshot(id, id === "s3" ? 3 : 1)),
  );
  generateDocsMock.mockReset();
  diffSnapshotsMock.mockReset();
});

it("shows the empty state with a generate button when there is no history", async () => {
  listSnapshotsMock.mockResolvedValue([]);
  renderPage();
  expect(await screen.findByText("Document this repository")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /generate documentation/i }),
  ).toBeInTheDocument();
});

it("lists every docs snapshot with its trigger and renders the latest", async () => {
  listSnapshotsMock.mockResolvedValue([
    summary("s3", "cccccccc3333", "auto"),
    summary("s2", "bbbbbbbb2222", "manual"),
    summary("s1", "aaaaaaaa1111", "manual"),
  ]);
  renderPage();

  // Every snapshot is a row in the history dropdown.
  expect(await screen.findByRole("menuitem", { name: /cccccccc/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /bbbbbbbb/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /aaaaaaaa/i })).toBeInTheDocument();
  expect(await screen.findByTestId("canvas")).toHaveTextContent("3 nodes");
  // The latest (auto) row carries the auto trigger badge.
  expect(screen.getByRole("menuitem", { name: /cccccccc.*auto/i })).toBeInTheDocument();
});

it("clicking an older snapshot loads it and shows the not-latest banner", async () => {
  listSnapshotsMock.mockResolvedValue([
    summary("s3", "cccccccc3333", "auto"),
    summary("s1", "aaaaaaaa1111", "manual"),
  ]);
  renderPage();
  await screen.findByTestId("canvas");

  fireEvent.click(await screen.findByRole("menuitem", { name: /aaaaaaaa/i }));

  expect(await screen.findByText(/not the latest/i)).toBeInTheDocument();
  expect(screen.getByTestId("canvas")).toHaveTextContent("1 nodes");

  // Back to latest restores the newest and hides the banner.
  fireEvent.click(screen.getByRole("button", { name: /back to latest/i }));
  expect(await screen.findByTestId("canvas")).toHaveTextContent("3 nodes");
  expect(screen.queryByText(/not the latest/i)).not.toBeInTheDocument();
});

it("regenerating creates a new latest and jumps to it", async () => {
  listSnapshotsMock
    .mockResolvedValueOnce([summary("s1", "aaaaaaaa1111", "manual")])
    .mockResolvedValueOnce([
      summary("s4", "dddddddd4444", "manual"),
      summary("s1", "aaaaaaaa1111", "manual"),
    ]);
  generateDocsMock.mockResolvedValue({ id: "s4" });

  renderPage();
  await screen.findByTestId("canvas");
  fireEvent.click(screen.getByRole("button", { name: /regenerate/i }));

  expect(await screen.findByText("dddddddd")).toBeInTheDocument();
  expect(getSnapshotMock).toHaveBeenCalledWith("s4");
});

it("handles a 409 while regenerating with a friendly message", async () => {
  listSnapshotsMock.mockResolvedValue([summary("s1", "aaaaaaaa1111", "manual")]);
  generateDocsMock.mockRejectedValue(new ApiError(409, "locked"));
  renderPage();
  await screen.findByTestId("canvas");
  fireEvent.click(screen.getByRole("button", { name: /regenerate/i }));
  expect(await screen.findByText(/already in progress/i)).toBeInTheDocument();
});

it("compares two docs snapshots (GP-40)", async () => {
  listSnapshotsMock.mockResolvedValue([
    summary("s2", "bbbbbbbb2222", "manual"),
    summary("s1", "aaaaaaaa1111", "manual"),
  ]);
  const diff: SnapshotDiff = {
    base: { id: "s1", commitSha: "aaaaaaaa1111", createdAt: "2026-01-01T00:00:00.000Z" },
    target: { id: "s2", commitSha: "bbbbbbbb2222", createdAt: "2026-01-03T00:00:00.000Z" },
    added: [{ id: "azurerm_subnet.b", name: "b", type: "azurerm_subnet", module_path: [] }],
    removed: [],
    moved: [],
    unchangedCount: 1,
  };
  diffSnapshotsMock.mockResolvedValue(diff);

  renderPage();
  await screen.findByTestId("canvas");

  // Enter compare mode, then pick the two timeline cards.
  fireEvent.click(screen.getByRole("button", { name: /^compare$/i }));
  expect(screen.getByText(/Compare mode/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /bbbbbbbb/i }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /aaaaaaaa/i }));

  // The diff summary strip appears; both ids were diffed.
  expect(await screen.findByText("+1 added")).toBeInTheDocument();
  const [baseArg, targetArg] = diffSnapshotsMock.mock.calls[0]!;
  expect(new Set([baseArg, targetArg])).toEqual(new Set(["s1", "s2"]));
});
