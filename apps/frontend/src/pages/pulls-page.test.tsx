import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getRepository: vi.fn(), listPulls: vi.fn() };
});

import { ApiError, getRepository, listPulls } from "@/api/client";
import type { PullSummary, Repository } from "@/api/types";
import { PullsPage } from "./pulls-page";

const getRepositoryMock = vi.mocked(getRepository);
const listPullsMock = vi.mocked(listPulls);

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
  createdAt: "2026-01-01T00:00:00.000Z",
};

function pull(over: Partial<PullSummary> = {}): PullSummary {
  return {
    id: "pr1",
    repositoryId: "r1",
    number: 5,
    title: "Add VPC",
    state: "open",
    sourceRef: "refs/heads/feat",
    latestCommitSha: "abcdef1234",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    latestSnapshot: {
      id: "s1",
      createdAt: "2026-01-03T00:00:00.000Z",
      stats: {
        nodes: 4,
        edges: 1,
        changes: { create: 2, update: 1, delete: 1, noop: 0, unchanged: 0 },
      },
    },
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/p1/repos/r1/pulls"]}>
      <Routes>
        <Route path="/projects/:id/repos/:repoId/pulls" element={<PullsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getRepositoryMock.mockReset();
  listPullsMock.mockReset();
  getRepositoryMock.mockResolvedValue(repo);
});

it("shows a loading state", () => {
  listPullsMock.mockReturnValue(new Promise<PullSummary[]>(() => {}));
  renderPage();
  expect(screen.getByText("Loading pull requests…")).toBeInTheDocument();
});

it("lists pull requests with change chips and links to detail", async () => {
  listPullsMock.mockResolvedValue([pull()]);
  renderPage();

  expect(await screen.findByText("Add VPC")).toBeInTheDocument();
  expect(screen.getByText("+2")).toBeInTheDocument();
  expect(screen.getByText("~1")).toBeInTheDocument();
  expect(screen.getByText("−1")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Add VPC/ })).toHaveAttribute(
    "href",
    "/projects/p1/repos/r1/pulls/5",
  );
});

it("shows the empty state when there are no pull requests", async () => {
  listPullsMock.mockResolvedValue([]);
  renderPage();
  expect(await screen.findByText("No pull requests yet")).toBeInTheDocument();
});

it("marks a closed PR and shows 'no diagram' without a snapshot", async () => {
  listPullsMock.mockResolvedValue([
    pull({ id: "pr2", number: 6, title: "Old", state: "closed", latestSnapshot: null }),
  ]);
  renderPage();
  expect(await screen.findByText("Old")).toBeInTheDocument();
  expect(screen.getByText("no diagram")).toBeInTheDocument();
});

it("shows an error state with the server message", async () => {
  listPullsMock.mockRejectedValue(new ApiError(500, "Kaboom"));
  renderPage();
  expect(await screen.findByText("Kaboom")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toBeInTheDocument();
});
