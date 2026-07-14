import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getCluster: vi.fn(),
    listClusterNamespaces: vi.fn(),
    listNamespaceSnapshots: vi.fn(),
    generateNamespaceSnapshot: vi.fn(),
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
  generateNamespaceSnapshot,
  getCluster,
  getSnapshot,
  listClusterNamespaces,
  listNamespaceSnapshots,
} from "@/api/client";
import type { Cluster, Graph, Snapshot, SnapshotSummary } from "@/api/types";
import { ClusterPage } from "./cluster-page";

const getClusterMock = vi.mocked(getCluster);
const listNamespacesMock = vi.mocked(listClusterNamespaces);
const listSnapshotsMock = vi.mocked(listNamespaceSnapshots);
const generateMock = vi.mocked(generateNamespaceSnapshot);
const getSnapshotMock = vi.mocked(getSnapshot);

const cluster: Cluster = {
  id: "c1",
  projectId: "p1",
  name: "production",
  kubeconfig: "***",
  connectionStatus: "ok",
  verifiedAt: "2026-07-14T10:00:00.000Z",
  createdAt: "2026-07-14T09:00:00.000Z",
};

const graph: Graph = {
  version: 6,
  nodes: [
    {
      id: "Namespace/payments",
      name: "payments",
      type: "Namespace",
      provider: "kubernetes",
      module_path: [],
      change: null,
    },
    {
      id: "Deployment/api",
      name: "api",
      type: "Deployment",
      provider: "kubernetes",
      module_path: [],
      change: null,
      parent_id: "Namespace/payments",
      labels: { app: "api" },
    },
  ],
  edges: [
    { from: "Namespace/payments", to: "Deployment/api", kind: "contains" },
  ],
};

function summary(over: Partial<SnapshotSummary> = {}): SnapshotSummary {
  return {
    id: "s1",
    repositoryId: null,
    clusterId: "c1",
    namespace: "payments",
    source: "k8s_namespace",
    ref: "payments",
    commitSha: "",
    prNumber: null,
    stats: {
      nodes: 2,
      edges: 1,
      changes: { create: 0, update: 0, delete: 0, noop: 0, unchanged: 2 },
    },
    createdAt: "2026-07-14T11:00:00.000Z",
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return { ...summary(), graph, summaryMd: "", ...over };
}

function renderPage(path = "/projects/p1/clusters/c1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      {/* In the app the page renders inside the layout's main region; axe should
          see it in one here too, rather than floating in a bare document. */}
      <main>
        <Routes>
          <Route path="/projects/:id/clusters/:clusterId" element={<ClusterPage />} />
        </Routes>
      </main>
    </MemoryRouter>,
  );
}

/** The header's Generate button — not the empty state's "Generate diagram". */
const generateButton = () => screen.findByRole("button", { name: "Generate" });

beforeEach(() => {
  getClusterMock.mockReset().mockResolvedValue(cluster);
  listNamespacesMock.mockReset().mockResolvedValue(["default", "payments"]);
  listSnapshotsMock.mockReset().mockResolvedValue([]);
  generateMock.mockReset().mockResolvedValue(snapshot());
  getSnapshotMock.mockReset().mockResolvedValue(snapshot());
});

it("picks a namespace, generates, and draws it", async () => {
  renderPage();

  const picker = await screen.findByLabelText(/namespace/i);
  fireEvent.change(picker, { target: { value: "payments" } });

  fireEvent.click(await generateButton());

  await waitFor(() => expect(generateMock).toHaveBeenCalledWith("c1", "payments"));
  expect(await screen.findByTestId("canvas")).toHaveTextContent("2 nodes");
});

it("a generation already running is a busy state, not an error", async () => {
  generateMock.mockRejectedValue(new ApiError(409, "already generating"));
  renderPage();

  fireEvent.change(await screen.findByLabelText(/namespace/i), {
    target: { value: "payments" },
  });
  fireEvent.click(await generateButton());

  const notice = await screen.findByRole("status");
  expect(notice).toHaveTextContent(/already (being read|generating|in progress)/i);
  // Not shouted at as a failure.
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("browses history and renders an older read", async () => {
  const older = summary({ id: "s0", createdAt: "2026-07-14T09:30:00.000Z" });
  listSnapshotsMock.mockResolvedValue([summary(), older]);
  renderPage();

  // Newest is selected on arrival.
  await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledWith("s1"));

  // The history rows are menu items (the <details> trigger is a summary, and its
  // content is in the DOM whether it is open or not).
  const rows = await screen.findAllByRole("menuitem");
  fireEvent.click(rows[1]!);

  await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledWith("s0"));
});

it("says when a namespace holds nothing we can map", async () => {
  const empty: Graph = {
    version: 6,
    nodes: [graph.nodes[0]!],
    edges: [],
  };
  listSnapshotsMock.mockResolvedValue([summary()]);
  getSnapshotMock.mockResolvedValue(snapshot({ graph: empty }));
  renderPage();

  expect(await screen.findByText(/nothing mappable/i)).toBeInTheDocument();
  expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();
});

it("a partial read says it is partial", async () => {
  listSnapshotsMock.mockResolvedValue([
    summary({
      stats: {
        ...summary().stats,
        warnings: ["not allowed to list Secret in namespace payments — skipped"],
      },
    }),
  ]);
  getSnapshotMock.mockResolvedValue(
    snapshot({
      stats: {
        ...summary().stats,
        warnings: ["not allowed to list Secret in namespace payments — skipped"],
      },
    }),
  );
  renderPage();

  expect(await screen.findByText(/not allowed to list Secret/i)).toBeInTheDocument();
});

it("a clean read shows no warnings notice", async () => {
  listSnapshotsMock.mockResolvedValue([summary()]);
  renderPage();

  await screen.findByTestId("canvas");
  expect(screen.queryByText(/skipped/i)).not.toBeInTheDocument();
});

it("offers no Terraform lenses, and ignores one asked for in the URL", async () => {
  listSnapshotsMock.mockResolvedValue([summary()]);
  renderPage("/projects/p1/clusters/c1?view=network");

  // The infra canvas is what a k8s snapshot has — the other views are lenses on
  // Terraform semantics, and empty ones would be noise.
  expect(await screen.findByTestId("canvas")).toHaveTextContent("2 nodes");
  expect(screen.queryByRole("button", { name: /^network$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^iam$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^c4$/i })).not.toBeInTheDocument();
});

it("an unreachable cluster says so instead of an empty picker", async () => {
  listNamespacesMock.mockRejectedValue(
    new ApiError(502, "could not read the cluster — check its connection and try again"),
  );
  renderPage();

  expect(await screen.findByRole("alert")).toHaveTextContent(/could not read the cluster/i);
});

it("has no accessibility violations", async () => {
  listSnapshotsMock.mockResolvedValue([summary()]);
  const { baseElement } = renderPage();
  await screen.findByTestId("canvas");
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
