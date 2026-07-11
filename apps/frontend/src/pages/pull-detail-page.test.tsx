import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getRepository: vi.fn(),
    getPull: vi.fn(),
    listSnapshots: vi.fn(),
    getSnapshot: vi.fn(),
  };
});

// The canvas (ELK + React Flow) is exercised in graph-canvas.test.tsx.
vi.mock("@/components/graph-canvas", () => ({
  GraphCanvas: ({ graph }: { graph: { nodes: unknown[] } }) => (
    <div data-testid="canvas">{graph.nodes.length} nodes</div>
  ),
}));

import {
  getPull,
  getRepository,
  getSnapshot,
  listSnapshots,
} from "@/api/client";
import type {
  PullDetail,
  Repository,
  Snapshot,
  SnapshotSummary,
} from "@/api/types";
import { PullDetailPage } from "./pull-detail-page";

const getRepositoryMock = vi.mocked(getRepository);
const getPullMock = vi.mocked(getPull);
const listSnapshotsMock = vi.mocked(listSnapshots);
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
  prCommentsEnabled: false,
  lastCommentError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function pull(over: Partial<PullDetail> = {}): PullDetail {
  return {
    id: "pr1",
    repositoryId: "r1",
    number: 5,
    title: "Add VPC",
    state: "open",
    sourceRef: "refs/heads/feat",
    latestCommitSha: "abcdef1234567",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    parseError: null,
    latestSnapshot: {
      id: "s1",
      createdAt: "2026-01-03T00:00:00.000Z",
      stats: {
        nodes: 3,
        edges: 1,
        changes: { create: 1, update: 0, delete: 0, noop: 0, unchanged: 0 },
      },
    },
    ...over,
  };
}

const snapshot: Snapshot = {
  id: "s1",
  repositoryId: "r1",
  source: "plan",
  ref: "refs/heads/feat",
  commitSha: "abcdef1234567",
  prNumber: 5,
  createdAt: "2026-01-03T00:00:00.000Z",
  stats: {
    nodes: 3,
    edges: 1,
    changes: { create: 1, update: 0, delete: 0, noop: 0, unchanged: 0 },
  },
  summaryMd: "**+1 created** (1 resource)\n\n**Created**\n- Data: 1 (s3)",
  graph: {
    version: 1,
    nodes: [
      { id: "aws_s3.a", name: "a", type: "aws_s3", provider: "aws", module_path: [], change: "create" },
    ],
    edges: [],
  },
};

const summary = (over: Partial<SnapshotSummary> = {}): SnapshotSummary => ({
  id: "s1",
  repositoryId: "r1",
  source: "plan",
  ref: "refs/heads/feat",
  commitSha: "abcdef1234567",
  prNumber: 5,
  createdAt: "2026-01-03T00:00:00.000Z",
  stats: snapshot.stats,
  ...over,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/p1/repos/r1/pulls/5"]}>
      <Routes>
        <Route
          path="/projects/:id/repos/:repoId/pulls/:number"
          element={<PullDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getRepositoryMock.mockReset().mockResolvedValue(repo);
  getPullMock.mockReset();
  listSnapshotsMock.mockReset().mockResolvedValue([]);
  getSnapshotMock.mockReset().mockResolvedValue(snapshot);
});

it("renders the header and the diagram for the latest snapshot", async () => {
  getPullMock.mockResolvedValue(pull());
  listSnapshotsMock.mockResolvedValue([summary()]);

  renderPage();

  expect(await screen.findByRole("heading", { name: "Add VPC" })).toBeInTheDocument();
  // ref → default branch + short sha in the meta line.
  expect(screen.getByText(/refs\/heads\/feat → main/)).toBeInTheDocument();
  expect(await screen.findByTestId("canvas")).toHaveTextContent("1 nodes");
  // GP-36: the deterministic change summary is shown at the top of the view.
  expect(await screen.findByText("Change summary")).toBeInTheDocument();
  expect(screen.getByText(/Data: 1 \(s3\)/)).toBeInTheDocument();
});

it("shows the empty state with the parse error when there is no snapshot", async () => {
  getPullMock.mockResolvedValue(
    pull({ latestSnapshot: null, parseError: "unexpected token at line 4" }),
  );

  renderPage();

  expect(await screen.findByText("No diagram yet")).toBeInTheDocument();
  expect(screen.getByText(/unexpected token at line 4/)).toBeInTheDocument();
  expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();
});

it("offers a snapshot dropdown when the PR has more than one", async () => {
  getPullMock.mockResolvedValue(pull());
  listSnapshotsMock.mockResolvedValue([
    summary({ id: "s2", commitSha: "newsha22" }),
    summary({ id: "s1", commitSha: "oldsha11" }),
  ]);

  renderPage();

  await screen.findByTestId("canvas");
  expect(screen.getByRole("combobox")).toBeInTheDocument();
});
