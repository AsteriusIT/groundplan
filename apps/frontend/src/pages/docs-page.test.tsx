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
    getAiStatus: vi.fn(),
    getAiGeneration: vi.fn(),
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
  getAiGeneration,
  getAiStatus,
  getRepository,
  getSnapshot,
  listSnapshots,
} from "@/api/client";
import { resetAiStatus } from "@/lib/use-ai-status";
import type { Repository, Snapshot, SnapshotDiff, SnapshotSummary } from "@/api/types";
import { DocsPage } from "./docs-page";

const getRepositoryMock = vi.mocked(getRepository);
const listSnapshotsMock = vi.mocked(listSnapshots);
const getSnapshotMock = vi.mocked(getSnapshot);
const generateDocsMock = vi.mocked(generateDocs);
const diffSnapshotsMock = vi.mocked(diffSnapshots);
const getAiStatusMock = vi.mocked(getAiStatus);
const getAiGenerationMock = vi.mocked(getAiGeneration);

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
  contextMd: null,
  terraformPath: "",
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
  // The AI layer is off unless a test turns it on (GP-65).
  resetAiStatus();
  getAiStatusMock.mockReset().mockResolvedValue({ enabled: false, model: null });
  getAiGenerationMock.mockReset().mockResolvedValue(null);
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

it("renders the IAM table (no change column) at ?view=iam (GP-48)", async () => {
  listSnapshotsMock.mockResolvedValue([summary("s1", "aaaaaaaa1111", "manual")]);
  getSnapshotMock.mockResolvedValue({
    ...summary("s1", "aaaaaaaa1111", "manual"),
    summaryMd: "No changes.",
    graph: {
      version: 4,
      nodes: [
        {
          id: "azurerm_role_assignment.owner",
          name: "owner",
          type: "azurerm_role_assignment",
          provider: "azurerm",
          module_path: [],
          change: null,
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

  render(
    <MemoryRouter initialEntries={["/projects/p1/repos/r1/docs?view=iam"]}>
      <Routes>
        <Route path="/projects/:id/repos/:repoId/docs" element={<DocsPage />} />
      </Routes>
    </MemoryRouter>,
  );

  expect(await screen.findByText("Owner")).toBeInTheDocument();
  // Docs context drops the change column, and the canvas is replaced.
  expect(screen.queryByRole("columnheader", { name: /change/i })).toBeNull();
  expect(screen.queryByTestId("canvas")).toBeNull();
});

it("keeps the context out of the header until the Context button opens the rail", async () => {
  getRepositoryMock.mockResolvedValue({ ...repo, contextMd: "# Payments platform" });
  listSnapshotsMock.mockResolvedValue([summary("s1", "aaaaaaaa1111", "manual")]);
  renderPage();
  await screen.findByTestId("canvas");

  expect(screen.queryByText(/Payments platform/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /^context$/i }));
  expect(await screen.findByText(/Payments platform/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /hide context/i }));
  expect(screen.queryByText(/Payments platform/)).toBeNull();
});

it("labels the infra tab 'Global' rather than 'Plan impact'", async () => {
  listSnapshotsMock.mockResolvedValue([summary("s1", "aaaaaaaa1111", "manual")]);
  renderPage();
  await screen.findByTestId("canvas");

  expect(screen.getByRole("button", { name: /^global$/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /plan impact/i })).toBeNull();
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

// --- GP-65: "Explain this infrastructure" -----------------------------------

it("shows no Explain button at all when the AI layer is off", async () => {
  listSnapshotsMock.mockResolvedValue([summary("s1", "aaa", "manual")]);

  renderPage();
  await screen.findByTestId("canvas");

  // Not a disabled button — no AI affordance whatsoever.
  expect(screen.queryByRole("button", { name: /explain/i })).not.toBeInTheDocument();
});

it("Explain opens a rail that generates prose for the selected snapshot", async () => {
  getAiStatusMock.mockResolvedValue({ enabled: true, model: "claude-opus-4-8" });
  listSnapshotsMock.mockResolvedValue([summary("s1", "aaa", "manual")]);
  getAiGenerationMock.mockResolvedValue({
    kind: "docs_explain",
    targetId: "s1",
    model: "claude-opus-4-8",
    output: "This system serves the storefront.",
    inputTokens: 10,
    outputTokens: 5,
    createdAt: "2026-07-13T00:00:00.000Z",
  });

  renderPage();
  await screen.findByTestId("canvas");

  // Closed by default — the diagram, not the prose, is what this page is for.
  expect(screen.queryByText(/serves the storefront/i)).not.toBeInTheDocument();

  fireEvent.click(await screen.findByRole("button", { name: /explain/i }));

  expect(await screen.findByText(/serves the storefront/i)).toBeInTheDocument();
  // The explanation is asked for by snapshot, so the timeline keeps its own.
  expect(getAiGenerationMock).toHaveBeenCalledWith("s1", "docs_explain");
  expect(screen.getByText(/AI-generated from the change model/i)).toBeInTheDocument();
});

// --- Snapshot warnings ------------------------------------------------------

/** A snapshot carrying parse warnings (a bad terraform path, a skipped file). */
function warned(id: string, warnings: string[]): Snapshot {
  const snap = snapshot(id, 0);
  return { ...snap, stats: { ...snap.stats, warnings } };
}

it("shows a lone parse warning in full, outside the canvas overlay", async () => {
  listSnapshotsMock.mockResolvedValue([summary("s1", "s1sha", "manual")]);
  getSnapshotMock.mockImplementation((id: string) =>
    Promise.resolve(warned(id, ["no .tf files found in 'does-not-exist'"])),
  );

  renderPage();

  // A single warning is the message itself — no "1 file skipped" to expand, and
  // no summary that lies about what happened.
  const banner = await screen.findByRole("status");
  expect(banner).toHaveTextContent("no .tf files found in 'does-not-exist'");

  // It lives in the page flow, not inside the canvas, where it used to sit under
  // the filter panel and go unread.
  expect(banner).not.toContainElement(screen.getByTestId("canvas"));
  expect(screen.getByTestId("canvas")).not.toContainElement(banner);
});

it("collapses many warnings behind a count, expandable on demand", async () => {
  const warnings = ["skipped a.tf: bad block", "skipped b.tf: bad block"];
  listSnapshotsMock.mockResolvedValue([summary("s1", "s1sha", "manual")]);
  getSnapshotMock.mockImplementation((id: string) =>
    Promise.resolve(warned(id, warnings)),
  );

  renderPage();

  const toggle = await screen.findByRole("button", { name: /2 warnings/i });
  expect(screen.queryByText(warnings[0]!)).not.toBeInTheDocument();

  fireEvent.click(toggle);
  expect(screen.getByText(warnings[0]!)).toBeInTheDocument();
  expect(screen.getByText(warnings[1]!)).toBeInTheDocument();
});

it("says nothing when a snapshot parsed cleanly", async () => {
  listSnapshotsMock.mockResolvedValue([summary("s1", "s1sha", "manual")]);
  renderPage();
  await screen.findByTestId("canvas");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
