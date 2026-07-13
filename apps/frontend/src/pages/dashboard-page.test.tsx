import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getDashboard: vi.fn() };
});

import { ApiError, getDashboard } from "@/api/client";
import type {
  Dashboard,
  DashboardDocsSnapshot,
  DashboardPull,
} from "@/api/types";
import { DashboardPage } from "./dashboard-page";

const getDashboardMock = vi.mocked(getDashboard);

function renderPage() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

function pull(over: Partial<DashboardPull> = {}): DashboardPull {
  return {
    id: "pr1",
    number: 42,
    title: "Add the payments VNet",
    state: "open",
    sourceRef: "refs/heads/payments-vnet",
    targetRef: "main",
    repositoryId: "r1",
    repositoryUrl: "https://github.com/acme/infra",
    projectId: "p1",
    updatedAt: "2026-07-10T10:00:00.000Z",
    latestSnapshot: {
      id: "s1",
      createdAt: "2026-07-10T10:00:00.000Z",
      stats: {
        nodes: 12,
        edges: 8,
        impactedCount: 3,
        changes: { create: 2, update: 1, delete: 0, noop: 0, unchanged: 9 },
      },
    },
    internetExposed: false,
    privileged: false,
    ...over,
  };
}

function docs(over: Partial<DashboardDocsSnapshot> = {}): DashboardDocsSnapshot {
  return {
    id: "d1",
    commitSha: "abcdef1234567890",
    trigger: "auto",
    repositoryId: "r1",
    repositoryUrl: "https://github.com/acme/infra",
    projectId: "p1",
    createdAt: "2026-07-11T09:00:00.000Z",
    ...over,
  };
}

function dashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    stats: { projects: 2, repositories: 3, openPrs: 1, orphanedAnnotations: 0 },
    recentPrs: [pull()],
    recentDocsSnapshots: [docs()],
    orphanRepositories: [],
    ...over,
  };
}

beforeEach(() => {
  getDashboardMock.mockReset();
});

it("shows a loading state", () => {
  getDashboardMock.mockReturnValue(new Promise<Dashboard>(() => {}));
  renderPage();
  expect(screen.getByText("Loading dashboard…")).toBeInTheDocument();
});

it("shows the stat cards", async () => {
  getDashboardMock.mockResolvedValue(dashboard());
  const { container } = renderPage();

  const card = async (label: string) =>
    await waitFor(() => {
      const el = container.querySelector(`[data-stat="${label}"]`);
      expect(el).not.toBeNull();
      return el!;
    });

  expect(await card("Projects")).toHaveTextContent("2");
  expect(await card("Repositories")).toHaveTextContent("3");
  expect(await card("Open pull requests")).toHaveTextContent("1");
  // The two cards with somewhere to go are links; open PRs has no list view.
  expect(await card("Projects")).toHaveAttribute("href", "/projects");
  expect((await card("Open pull requests")).tagName).toBe("DIV");
});

it("hides the orphan card when nothing is orphaned", async () => {
  getDashboardMock.mockResolvedValue(dashboard());
  renderPage();
  await screen.findByText("Repositories");
  expect(screen.queryByText(/orphaned annotation/i)).not.toBeInTheDocument();
});

it("links the orphan card to the review of the worst-hit repository", async () => {
  getDashboardMock.mockResolvedValue(
    dashboard({
      stats: {
        projects: 2,
        repositories: 3,
        openPrs: 1,
        orphanedAnnotations: 4,
      },
      orphanRepositories: [
        {
          repositoryId: "r9",
          repositoryUrl: "https://github.com/acme/infra",
          projectId: "p9",
          count: 4,
        },
      ],
    }),
  );
  renderPage();

  const card = await screen.findByRole("link", { name: /orphaned annotations/i });
  expect(card).toHaveTextContent("4");
  // Orphan review lives on the repository's docs page (GP-59).
  expect(card).toHaveAttribute("href", "/projects/p9/repos/r9/docs");
});

it("lists a recent PR with its change stats and links to its view", async () => {
  getDashboardMock.mockResolvedValue(dashboard());
  renderPage();

  const row = await screen.findByRole("link", { name: /add the payments vnet/i });
  expect(row).toHaveAttribute("href", "/projects/p1/repos/r1/pulls/42");
  expect(row).toHaveTextContent("acme/infra");
  // Branch → target, with the refs/heads prefix stripped.
  expect(row).toHaveTextContent("payments-vnet");
  expect(row).toHaveTextContent("main");
  // +create ~update −delete, from the latest plan snapshot.
  expect(row).toHaveTextContent("+2");
  expect(row).toHaveTextContent("~1");
});

it("badges a PR whose plan is internet-exposed or privileged", async () => {
  getDashboardMock.mockResolvedValue(
    dashboard({
      recentPrs: [pull({ internetExposed: true, privileged: true })],
    }),
  );
  renderPage();

  const row = await screen.findByRole("link", { name: /add the payments vnet/i });
  expect(row).toHaveTextContent(/exposed/i);
  expect(row).toHaveTextContent(/privileged/i);
});

it("shows no risk badges when the plan carries no flags", async () => {
  getDashboardMock.mockResolvedValue(dashboard());
  renderPage();
  const row = await screen.findByRole("link", { name: /add the payments vnet/i });
  expect(row).not.toHaveTextContent(/exposed/i);
  expect(row).not.toHaveTextContent(/privileged/i);
});

it("falls back to the number for a PR with no title, and says when it has no diagram", async () => {
  getDashboardMock.mockResolvedValue(
    dashboard({ recentPrs: [pull({ title: null, latestSnapshot: null })] }),
  );
  renderPage();

  const row = await screen.findByRole("link", { name: /pull request #42/i });
  expect(row).toHaveTextContent("no diagram");
});

it("lists a recent docs snapshot with its sha and trigger, linking to the docs view", async () => {
  getDashboardMock.mockResolvedValue(dashboard());
  renderPage();

  const row = await screen.findByRole("link", { name: /acme\/infra.*abcdef12/is });
  expect(row).toHaveAttribute("href", "/projects/p1/repos/r1/docs");
  expect(row).toHaveTextContent("abcdef12");
  expect(row).toHaveTextContent(/auto/i);
});

it("greets a fresh user with one call to action instead of empty tables", async () => {
  getDashboardMock.mockResolvedValue({
    stats: { projects: 0, repositories: 0, openPrs: 0, orphanedAnnotations: 0 },
    recentPrs: [],
    recentDocsSnapshots: [],
    orphanRepositories: [],
  });
  renderPage();

  const cta = await screen.findByRole("link", {
    name: /attach your first repository/i,
  });
  expect(cta).toHaveAttribute("href", "/projects");
  // No empty tables behind the CTA.
  expect(screen.queryByText("Recent pull requests")).not.toBeInTheDocument();
  expect(screen.queryByText("Recent documentation updates")).not.toBeInTheDocument();
});

it("keeps the lists (with their own empty notes) once a repository exists", async () => {
  getDashboardMock.mockResolvedValue({
    stats: { projects: 1, repositories: 1, openPrs: 0, orphanedAnnotations: 0 },
    recentPrs: [],
    recentDocsSnapshots: [],
    orphanRepositories: [],
  });
  renderPage();

  expect(await screen.findByText("Recent pull requests")).toBeInTheDocument();
  expect(screen.getByText(/no pull requests yet/i)).toBeInTheDocument();
  expect(screen.getByText(/no documentation generated yet/i)).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /attach your first repository/i }),
  ).not.toBeInTheDocument();
});

it("surfaces a load failure with a retry", async () => {
  getDashboardMock.mockRejectedValue(new ApiError(500, "boom"));
  renderPage();

  expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
});

it("has no accessibility violations", async () => {
  getDashboardMock.mockResolvedValue(dashboard());
  const { container } = renderPage();
  await screen.findByText("Recent pull requests");
  const results = await axe(container);
  expect(results.violations).toEqual([]);
});
