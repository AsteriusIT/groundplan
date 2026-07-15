import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { TourStyleProvider } from "@/tour/tour-style";

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
  GraphCanvas: ({
    graph,
    focusNodeId,
  }: {
    graph: { nodes: unknown[] };
    focusNodeId?: string | null;
  }) => (
    <div data-testid="canvas" data-focus={focusNodeId ?? ""}>
      {graph.nodes.length} nodes
    </div>
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
  iacType: "terraform",
  url: "https://github.com/acme/infra",
  defaultBranch: "main",
  accessToken: null,
  connectionStatus: "ok",
  verifiedAt: null,
  prCommentsEnabled: false,
  lastCommentError: null,
  contextMd: null,
  terraformPath: "",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function pull(over: Partial<PullDetail> = {}): PullDetail {
  return {
    id: "pr1",
    repositoryId: "r1",
    number: 5,
    title: "Add VPC",
    state: "open",
    closedAt: null,
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
  clusterId: null,
  namespace: null,
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
  clusterId: null,
  namespace: null,
  source: "plan",
  ref: "refs/heads/feat",
  commitSha: "abcdef1234567",
  prNumber: 5,
  createdAt: "2026-01-03T00:00:00.000Z",
  stats: snapshot.stats,
  ...over,
});

function renderPage(entry = "/projects/p1/repos/r1/pulls/5") {
  return render(
    <TourStyleProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/projects/:id/repos/:repoId/pulls/:number"
            element={<PullDetailPage />}
          />
        </Routes>
      </MemoryRouter>
    </TourStyleProvider>,
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

it("renders the IAM table (with a change column) at ?view=iam (GP-48)", async () => {
  getPullMock.mockResolvedValue(pull());
  listSnapshotsMock.mockResolvedValue([summary()]);
  getSnapshotMock.mockResolvedValue({
    ...snapshot,
    graph: {
      version: 4,
      nodes: [
        {
          id: "azurerm_role_assignment.owner",
          name: "owner",
          type: "azurerm_role_assignment",
          provider: "azurerm",
          module_path: [],
          change: "create",
          role_assignment: {
            role: "Owner",
            principal: "sp-x",
            scope: "azurerm_resource_group.main",
          },
          privileged: true,
        },
      ],
      edges: [],
    },
  });

  renderPage("/projects/p1/repos/r1/pulls/5?view=iam");

  expect(await screen.findByText("Owner")).toBeInTheDocument();
  // PR context keeps the change column; the canvas is replaced by the table.
  expect(screen.getByRole("columnheader", { name: /change/i })).toBeInTheDocument();
  expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();
});

it("jumps from an IAM row to the plan-impact canvas with the node focused (GP-49)", async () => {
  getPullMock.mockResolvedValue(pull());
  listSnapshotsMock.mockResolvedValue([summary()]);
  getSnapshotMock.mockResolvedValue({
    ...snapshot,
    graph: {
      version: 4,
      nodes: [
        {
          id: "azurerm_role_assignment.owner",
          name: "owner",
          type: "azurerm_role_assignment",
          provider: "azurerm",
          module_path: [],
          change: "create",
          role_assignment: {
            role: "Owner",
            principal: "sp-x",
            scope: "azurerm_resource_group.main",
          },
          privileged: true,
        },
      ],
      edges: [],
    },
  });

  renderPage("/projects/p1/repos/r1/pulls/5?view=iam");

  // Open the row's panel, then use its "View in plan-impact" action.
  fireEvent.click(await screen.findByText("Owner"));
  fireEvent.click(screen.getByRole("button", { name: /view in plan.impact/i }));

  // The canvas is now shown, focused on the assignment node (selection preserved).
  const canvas = await screen.findByTestId("canvas");
  expect(canvas).toHaveAttribute("data-focus", "azurerm_role_assignment.owner");
});

it("offers a snapshot dropdown when the PR has more than one", async () => {
  getPullMock.mockResolvedValue(pull());
  listSnapshotsMock.mockResolvedValue([
    summary({ id: "s2", commitSha: "newsha22" }),
    summary({ id: "s1", commitSha: "oldsha11" }),
  ]);

  renderPage();

  await screen.findByTestId("canvas");
  // Both snapshots are rows in the history dropdown.
  expect(screen.getByRole("menuitem", { name: /newsha22/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /oldsha11/i })).toBeInTheDocument();
});

// --- GP-105: a Kubernetes pull request, reviewed on the same page ---

/** What GP-103 stores for a rendered manifests PR: an ordinary coloured graph. */
const k8sSnapshot: Snapshot = {
  ...snapshot,
  source: "k8s_rendered",
  stats: {
    nodes: 3,
    edges: 2,
    changes: { create: 1, update: 1, delete: 1, noop: 0, unchanged: 0 },
  },
  summaryMd: "**~1 updated, +1 created, −1 destroyed**",
  graph: {
    version: 7,
    nodes: [
      {
        id: "Namespace/prod",
        name: "prod",
        type: "Namespace",
        provider: "kubernetes",
        module_path: [],
        change: "noop",
      },
      {
        id: "prod/Deployment/api",
        name: "api",
        type: "Deployment",
        provider: "kubernetes",
        module_path: [],
        change: "update",
        parent_id: "Namespace/prod",
        attribute_diff: [
          {
            key: "spec.template.spec.containers[0].image",
            before: "acme/api:1.4.0",
            after: "acme/api:1.5.0",
          },
        ],
      },
      {
        id: "prod/Service/api",
        name: "api",
        type: "Service",
        provider: "kubernetes",
        module_path: [],
        change: "create",
        parent_id: "Namespace/prod",
      },
    ],
    edges: [
      { from: "Namespace/prod", to: "prod/Deployment/api", kind: "contains" },
      { from: "Namespace/prod", to: "prod/Service/api", kind: "contains" },
    ],
  },
};

it("draws a kubernetes pull request on the same canvas, with its own summary", async () => {
  getRepositoryMock.mockResolvedValue({ ...repo, iacType: "kubernetes" });
  getPullMock.mockResolvedValue(pull());
  getSnapshotMock.mockResolvedValue(k8sSnapshot);
  listSnapshotsMock.mockResolvedValue([summary({ source: "k8s_rendered" })]);

  renderPage();

  // The renderer needed no changes: a manifest snapshot is a GraphSnapshot.
  expect(await screen.findByTestId("canvas")).toHaveTextContent("3 nodes");
  // And the deterministic summary is the one the PR comment carries.
  expect(screen.getByText(/1 updated, \+1 created/i)).toBeInTheDocument();
});

it("offers a kubernetes pull request no Terraform lens, and ignores one asked for in the URL", async () => {
  getRepositoryMock.mockResolvedValue({ ...repo, iacType: "kubernetes" });
  getPullMock.mockResolvedValue(pull());
  getSnapshotMock.mockResolvedValue(k8sSnapshot);
  listSnapshotsMock.mockResolvedValue([summary({ source: "k8s_rendered" })]);

  // A deep link from a Terraform diagram, followed on a Kubernetes one.
  renderPage("/projects/p1/repos/r1/pulls/5?view=network");

  // It lands on the diagram rather than on an empty lens (the GP-99 rule).
  expect(await screen.findByTestId("canvas")).toHaveTextContent("3 nodes");
  expect(screen.queryByRole("button", { name: /^network$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^iam$/i })).not.toBeInTheDocument();
  // With one view to offer, there is nothing to switch.
  expect(screen.queryByRole("group", { name: "Graph view" })).not.toBeInTheDocument();
});

it("still offers a Terraform pull request its lenses", async () => {
  getRepositoryMock.mockResolvedValue(repo);
  getPullMock.mockResolvedValue(pull());
  getSnapshotMock.mockResolvedValue(snapshot);
  listSnapshotsMock.mockResolvedValue([summary()]);

  renderPage();

  expect(await screen.findByTestId("canvas")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^network$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^iam$/i })).toBeInTheDocument();
});
