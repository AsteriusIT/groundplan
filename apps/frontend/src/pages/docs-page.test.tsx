import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getRepository: vi.fn(),
    getLatestDocs: vi.fn(),
    generateDocs: vi.fn(),
    getSnapshot: vi.fn(),
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
  generateDocs,
  getLatestDocs,
  getRepository,
  getSnapshot,
} from "@/api/client";
import type { Repository, Snapshot } from "@/api/types";
import { DocsPage } from "./docs-page";

const getRepositoryMock = vi.mocked(getRepository);
const getLatestDocsMock = vi.mocked(getLatestDocs);
const generateDocsMock = vi.mocked(generateDocs);
const getSnapshotMock = vi.mocked(getSnapshot);

const repo: Repository = {
  id: "r1",
  projectId: "p1",
  provider: "github",
  url: "https://github.com/acme/infra",
  defaultBranch: "main",
  accessToken: null,
  connectionStatus: "ok",
  verifiedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    id: "s1",
    repositoryId: "r1",
    source: "hcl",
    ref: "main",
    commitSha: "abcdef1234567",
    prNumber: null,
    createdAt: "2026-01-03T00:00:00.000Z",
    stats: {
      nodes: 2,
      edges: 0,
      changes: { create: 0, update: 0, delete: 0, noop: 0, unchanged: 2 },
      warnings: [],
    },
    graph: {
      version: 1,
      nodes: [
        { id: "aws_s3.a", name: "a", type: "aws_s3", provider: "aws", module_path: [], change: null },
        { id: "module.net", name: "net", type: "module", provider: null, module_path: [], change: null },
      ],
      edges: [],
    },
    ...over,
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
  getLatestDocsMock.mockReset();
  generateDocsMock.mockReset();
  getSnapshotMock.mockReset();
});

it("shows the empty state with a generate button when there are no docs", async () => {
  getLatestDocsMock.mockRejectedValue(new ApiError(404, "no documentation snapshot yet"));
  renderPage();
  expect(await screen.findByText("Document this repository")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /generate documentation/i }),
  ).toBeInTheDocument();
});

it("generates documentation and renders the neutral diagram", async () => {
  getLatestDocsMock.mockRejectedValue(new ApiError(404, "none"));
  generateDocsMock.mockResolvedValue({ id: "s1" });
  getSnapshotMock.mockResolvedValue(snapshot());

  renderPage();
  fireEvent.click(
    await screen.findByRole("button", { name: /generate documentation/i }),
  );

  const canvas = await screen.findByTestId("canvas");
  expect(canvas).toHaveTextContent("2 nodes");
  expect(canvas).toHaveAttribute("data-variant", "docs");
  // Header shows the commit sha of the generated snapshot.
  expect(screen.getByText(/abcdef12/)).toBeInTheDocument();
});

it("renders an existing docs snapshot on load", async () => {
  getLatestDocsMock.mockResolvedValue(snapshot());
  renderPage();
  expect(await screen.findByTestId("canvas")).toHaveTextContent("2 nodes");
  expect(
    screen.getByRole("button", { name: /regenerate/i }),
  ).toBeInTheDocument();
});

it("shows warnings when the snapshot has skipped files", async () => {
  getLatestDocsMock.mockResolvedValue(
    snapshot({
      stats: {
        nodes: 2,
        edges: 0,
        changes: { create: 0, update: 0, delete: 0, noop: 0, unchanged: 2 },
        warnings: ["skipped broken.tf: unbalanced braces"],
      },
    }),
  );
  renderPage();
  await screen.findByTestId("canvas");
  expect(screen.getByText(/1 file skipped/i)).toBeInTheDocument();
});

it("handles a 409 (generation already running) with a friendly message", async () => {
  getLatestDocsMock.mockRejectedValue(new ApiError(404, "none"));
  generateDocsMock.mockRejectedValue(new ApiError(409, "already running"));

  renderPage();
  fireEvent.click(
    await screen.findByRole("button", { name: /generate documentation/i }),
  );

  expect(
    await screen.findByText(/already in progress/i),
  ).toBeInTheDocument();
});
