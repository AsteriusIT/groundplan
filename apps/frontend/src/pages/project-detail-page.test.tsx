import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getProject: vi.fn(),
    listRepositories: vi.fn(),
    createRepository: vi.fn(),
    verifyRepository: vi.fn(),
    updateRepository: vi.fn(),
    deleteProject: vi.fn(),
  };
});

import {
  ApiError,
  createRepository,
  deleteProject,
  getProject,
  listRepositories,
  updateRepository,
  verifyRepository,
} from "@/api/client";
import type { CreatedRepository, Project, Repository } from "@/api/types";
import { ProjectDetailPage } from "./project-detail-page";

const getProjectMock = vi.mocked(getProject);
const listRepositoriesMock = vi.mocked(listRepositories);
const createRepositoryMock = vi.mocked(createRepository);
const verifyRepositoryMock = vi.mocked(verifyRepository);
const updateRepositoryMock = vi.mocked(updateRepository);
const deleteProjectMock = vi.mocked(deleteProject);

const project: Project = {
  id: "p1",
  name: "Prod Platform",
  slug: "prod-platform",
  createdAt: "2026-01-02T00:00:00.000Z",
};

function repo(over: Partial<Repository> = {}): Repository {
  return {
    id: "r1",
    projectId: "p1",
    provider: "github",
    url: "https://github.com/acme/infra",
    defaultBranch: "main",
    accessToken: null,
    connectionStatus: "ok",
    verifiedAt: "2026-01-03T00:00:00.000Z",
    prCommentsEnabled: false,
    lastCommentError: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getProjectMock.mockReset();
  listRepositoriesMock.mockReset();
  createRepositoryMock.mockReset();
  verifyRepositoryMock.mockReset();
  updateRepositoryMock.mockReset();
  deleteProjectMock.mockReset();
  getProjectMock.mockResolvedValue(project);
});

it("shows a loading state", () => {
  listRepositoriesMock.mockReturnValue(new Promise<Repository[]>(() => {}));
  renderPage();
  expect(screen.getByText("Loading project…")).toBeInTheDocument();
});

it("renders the repository list with its connection status", async () => {
  listRepositoriesMock.mockResolvedValue([repo({ connectionStatus: "ok" })]);
  renderPage();
  expect(await screen.findByText("acme/infra")).toBeInTheDocument();
  expect(screen.getByText("Connected")).toBeInTheDocument();
});

it("shows the empty state when there are no repositories", async () => {
  listRepositoriesMock.mockResolvedValue([]);
  renderPage();
  expect(await screen.findByText("No repositories yet")).toBeInTheDocument();
});

it("shows an error state with the server message", async () => {
  listRepositoriesMock.mockRejectedValue(new ApiError(500, "Boom"));
  renderPage();
  expect(await screen.findByText("Boom")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

it("attaches a public repo, shows a connected status and the CI setup", async () => {
  listRepositoriesMock.mockResolvedValue([]);
  const created: CreatedRepository = {
    ...repo({ id: "new", connectionStatus: "ok" }),
    webhookToken: "wh-secret-token",
  };
  createRepositoryMock.mockResolvedValue(created);

  renderPage();
  fireEvent.click(
    await screen.findByRole("button", { name: /attach your first repository/i }),
  );
  fireEvent.change(await screen.findByLabelText("Repository URL"), {
    target: { value: "https://github.com/acme/infra" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^attach repository$/i }));

  // Success step: connected badge, one-time token and the CI workflow snippet.
  expect(await screen.findByText("Repository attached")).toBeInTheDocument();
  expect(screen.getByText("wh-secret-token")).toBeInTheDocument();
  expect(screen.getByText(/GitHub Actions workflow/i)).toBeInTheDocument();
  expect(
    screen.getAllByRole("button", { name: /copy/i }).length,
  ).toBeGreaterThanOrEqual(3);
});

it("surfaces an explicit auth_failed message when a bad PAT is used", async () => {
  listRepositoriesMock.mockResolvedValue([]);
  createRepositoryMock.mockResolvedValue({
    ...repo({ id: "new", connectionStatus: "failed", accessToken: "***" }),
    webhookToken: "wh",
  });
  verifyRepositoryMock.mockResolvedValue({ ok: false, error: "auth_failed" });

  renderPage();
  fireEvent.click(
    await screen.findByRole("button", { name: /attach your first repository/i }),
  );
  fireEvent.change(await screen.findByLabelText("Repository URL"), {
    target: { value: "https://github.com/acme/private" },
  });
  fireEvent.change(screen.getByLabelText("Access token"), {
    target: { value: "bad-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^attach repository$/i }));

  expect(await screen.findByText(/authentication failed/i)).toBeInTheDocument();
});

it("re-verifies a repository and reflects the new status", async () => {
  listRepositoriesMock.mockResolvedValue([repo({ connectionStatus: "unverified" })]);
  verifyRepositoryMock.mockResolvedValue({ ok: true, default_branch_found: true });

  renderPage();
  const row = (await screen.findByText("acme/infra")).closest("div")!
    .parentElement!.parentElement!;
  expect(within(row).getByText("Not verified")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));

  expect(await screen.findByText("Connected")).toBeInTheDocument();
});

it("toggles GitHub PR comments for a repository (GP-38)", async () => {
  listRepositoriesMock.mockResolvedValue([repo({ prCommentsEnabled: false })]);
  updateRepositoryMock.mockResolvedValue(repo({ prCommentsEnabled: true }));

  renderPage();

  const toggle = await screen.findByRole("checkbox", {
    name: /comment on github pull requests/i,
  });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);

  expect(updateRepositoryMock).toHaveBeenCalledWith("r1", { prCommentsEnabled: true });
  expect(await screen.findByRole("checkbox", { name: /comment on github pull requests/i })).toBeChecked();
});

it("surfaces the last PR comment error", async () => {
  listRepositoriesMock.mockResolvedValue([
    repo({ prCommentsEnabled: true, lastCommentError: "GitHub API 403: forbidden" }),
  ]);

  renderPage();

  expect(await screen.findByText(/Last PR comment failed/i)).toBeInTheDocument();
});

it("deletes the project and navigates to the projects list", async () => {
  listRepositoriesMock.mockResolvedValue([]);
  deleteProjectMock.mockResolvedValue(undefined);
  render(
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects" element={<div>Projects list page</div>} />
      </Routes>
    </MemoryRouter>,
  );

  // Only the header trigger exists before the dialog opens.
  fireEvent.click(await screen.findByRole("button", { name: "Delete project" }));

  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/type the project name/i), {
    target: { value: "Prod Platform" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete project" }));

  expect(await screen.findByText("Projects list page")).toBeInTheDocument();
  expect(deleteProjectMock).toHaveBeenCalledWith("p1");
});
