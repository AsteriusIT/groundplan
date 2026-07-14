import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getProject: vi.fn(),
    listRepositories: vi.fn(),
    listRepositoryActivity: vi.fn(),
    listClusters: vi.fn(),
    createRepository: vi.fn(),
    verifyRepository: vi.fn(),
    updateRepository: vi.fn(),
    deleteRepository: vi.fn(),
    deleteProject: vi.fn(),
  };
});

import {
  ApiError,
  createRepository,
  deleteProject,
  deleteRepository,
  getProject,
  listClusters,
  listRepositories,
  listRepositoryActivity,
  updateRepository,
  verifyRepository,
} from "@/api/client";
import type {
  CreatedRepository,
  Project,
  Repository,
  RepositoryActivity,
} from "@/api/types";
import { ProjectDetailPage } from "./project-detail-page";

const getProjectMock = vi.mocked(getProject);
const listRepositoriesMock = vi.mocked(listRepositories);
const listRepositoryActivityMock = vi.mocked(listRepositoryActivity);
const createRepositoryMock = vi.mocked(createRepository);
const verifyRepositoryMock = vi.mocked(verifyRepository);
const updateRepositoryMock = vi.mocked(updateRepository);
const deleteRepositoryMock = vi.mocked(deleteRepository);
const deleteProjectMock = vi.mocked(deleteProject);
const listClustersMock = vi.mocked(listClusters);

const project: Project = {
  id: "p1",
  name: "Prod Platform",
  slug: "prod-platform",
  contextMd: null,
  createdAt: "2026-01-02T00:00:00.000Z",
};

function repo(over: Partial<Repository> = {}): Repository {
  return {
    id: "r1",
    projectId: "p1",
    provider: "github",
    iacType: "terraform",
    url: "https://github.com/acme/infra",
    defaultBranch: "main",
    accessToken: null,
    connectionStatus: "ok",
    verifiedAt: "2026-01-03T00:00:00.000Z",
    prCommentsEnabled: false,
    lastCommentError: null,
    contextMd: null,
    terraformPath: "",
    createdAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

function activity(over: Partial<RepositoryActivity> = {}): RepositoryActivity {
  return {
    repositoryId: "r1",
    openPrs: 0,
    lastSnapshotAt: null,
    lastEventAt: null,
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

/** Open a Radix dropdown from its trigger (it opens on keydown, not click). */
async function openMenu(name: RegExp | string) {
  fireEvent.keyDown(await screen.findByRole("button", { name }), { key: "Enter" });
}

beforeEach(() => {
  getProjectMock.mockReset();
  listRepositoriesMock.mockReset();
  listRepositoryActivityMock.mockReset();
  createRepositoryMock.mockReset();
  verifyRepositoryMock.mockReset();
  updateRepositoryMock.mockReset();
  deleteRepositoryMock.mockReset();
  deleteProjectMock.mockReset();
  listClustersMock.mockReset();
  getProjectMock.mockResolvedValue(project);
  listRepositoryActivityMock.mockResolvedValue([]);
  listClustersMock.mockResolvedValue([]);
});

it("a project is repositories — clusters live at the top level, not in here", async () => {
  listRepositoriesMock.mockResolvedValue([repo()]);
  renderPage();

  expect(await screen.findByText("acme/infra")).toBeInTheDocument();
  // Clusters moved out: they are peers of a project, not parts of one. The page
  // must not grow the section back — nor go asking the API for them.
  expect(screen.queryByText(/cluster/i)).not.toBeInTheDocument();
  expect(listClustersMock).not.toHaveBeenCalled();
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
  // Status is metadata beside the name, not a pill competing with the actions.
  expect(screen.getByRole("img", { name: "Connected" })).toBeInTheDocument();
  expect(screen.getByText("Repositories")).toBeInTheDocument();
  expect(screen.getByText("(1)")).toBeInTheDocument();
});

it("keeps the two destinations on the row and everything else in the menu", async () => {
  listRepositoriesMock.mockResolvedValue([repo()]);
  renderPage();

  expect(await screen.findByRole("link", { name: /pull requests/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /docs/i })).toBeInTheDocument();

  // Maintenance actions are not competing for attention until you ask for them.
  expect(screen.queryByRole("button", { name: /verify/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /ci setup/i })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /remove repository/i }),
  ).not.toBeInTheDocument();

  await openMenu(/manage acme\/infra/i);
  const menu = await screen.findByRole("menu");
  for (const item of [
    /verify connection/i,
    /repository settings/i,
    /ci setup/i,
    /remove repository/i,
  ]) {
    expect(within(menu).getByRole("menuitem", { name: item })).toBeInTheDocument();
  }
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

it("re-verifies a repository from the menu and reflects the new status", async () => {
  listRepositoriesMock.mockResolvedValue([repo({ connectionStatus: "unverified" })]);
  verifyRepositoryMock.mockResolvedValue({ ok: true, default_branch_found: true });

  renderPage();
  expect(await screen.findByRole("img", { name: "Not verified" })).toBeInTheDocument();

  await openMenu(/manage acme\/infra/i);
  fireEvent.click(await screen.findByRole("menuitem", { name: /verify connection/i }));

  expect(await screen.findByRole("img", { name: "Connected" })).toBeInTheDocument();
});

// --- Per-repository activity (rec 7: does the page earn its space?) ---------

it("shows each repository's freshness: last plan, open PRs, last CI event", async () => {
  listRepositoriesMock.mockResolvedValue([repo()]);
  listRepositoryActivityMock.mockResolvedValue([
    activity({
      openPrs: 3,
      lastSnapshotAt: "2026-07-11T12:00:00.000Z",
      lastEventAt: "2026-07-13T11:00:00.000Z",
    }),
  ]);

  renderPage();

  expect(await screen.findByText("Last plan")).toBeInTheDocument();
  expect(screen.getByText("Open PRs")).toBeInTheDocument();
  expect(screen.getByText("3")).toBeInTheDocument();
  expect(screen.getByText("Last CI event")).toBeInTheDocument();
});

it("says so when CI has never reached a repository", async () => {
  listRepositoriesMock.mockResolvedValue([repo()]);
  listRepositoryActivityMock.mockResolvedValue([activity()]);

  renderPage();

  expect(await screen.findByText(/no ci events yet/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /set up ci/i })).toBeInTheDocument();
});

it("still lists the repositories when the activity call fails", async () => {
  listRepositoriesMock.mockResolvedValue([repo()]);
  listRepositoryActivityMock.mockRejectedValue(new ApiError(500, "nope"));

  renderPage();

  expect(await screen.findByText("acme/infra")).toBeInTheDocument();
  expect(screen.queryByText("Last plan")).not.toBeInTheDocument();
});

// --- Repository settings (rec 2: set-once configuration, not a daily action) --

it("toggles GitHub PR comments from the repository settings dialog (GP-38)", async () => {
  listRepositoriesMock.mockResolvedValue([repo({ prCommentsEnabled: false })]);
  updateRepositoryMock.mockResolvedValue(repo({ prCommentsEnabled: true }));

  renderPage();
  await openMenu(/manage acme\/infra/i);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /repository settings/i }),
  );

  const dialog = await screen.findByRole("dialog");
  const toggle = within(dialog).getByRole("checkbox", {
    name: /comment on github pull requests/i,
  });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  fireEvent.click(within(dialog).getByRole("button", { name: /save settings/i }));

  expect(updateRepositoryMock).toHaveBeenCalledWith("r1", {
    prCommentsEnabled: true,
  });
});

it("sends only the fields the user touched", async () => {
  listRepositoriesMock.mockResolvedValue([repo({ defaultBranch: "main" })]);
  updateRepositoryMock.mockResolvedValue(repo({ defaultBranch: "trunk" }));

  renderPage();
  await openMenu(/manage acme\/infra/i);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /repository settings/i }),
  );

  const dialog = await screen.findByRole("dialog");
  // Untouched form → nothing to save.
  expect(within(dialog).getByRole("button", { name: /save settings/i })).toBeDisabled();

  fireEvent.change(within(dialog).getByLabelText(/default branch/i), {
    target: { value: "trunk" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: /save settings/i }));

  expect(updateRepositoryMock).toHaveBeenCalledWith("r1", { defaultBranch: "trunk" });
});

it("shows the terraform path on the card, but only when it is not the root", async () => {
  listRepositoriesMock.mockResolvedValue([
    repo({ id: "r1", terraformPath: "infra/azure" }),
    repo({ id: "r2", url: "https://github.com/acme/rooted", terraformPath: "" }),
  ]);

  renderPage();

  expect(await screen.findByText("infra/azure")).toBeInTheDocument();
  // The rooted repo says nothing — silence means "the whole repository".
  expect(screen.getAllByText("main")).toHaveLength(2);
});

it("moves a repository's terraform path from settings", async () => {
  listRepositoriesMock.mockResolvedValue([repo({ terraformPath: "" })]);
  updateRepositoryMock.mockResolvedValue(repo({ terraformPath: "infra" }));

  renderPage();
  await openMenu(/manage acme\/infra/i);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /repository settings/i }),
  );

  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/terraform path/i), {
    target: { value: "infra" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: /save settings/i }));

  expect(updateRepositoryMock).toHaveBeenCalledWith("r1", { terraformPath: "infra" });
  expect(await screen.findByText("infra")).toBeInTheDocument();
});

it("clearing the terraform path moves it back to the repository root", async () => {
  listRepositoriesMock.mockResolvedValue([repo({ terraformPath: "infra" })]);
  updateRepositoryMock.mockResolvedValue(repo({ terraformPath: "" }));

  renderPage();
  await openMenu(/manage acme\/infra/i);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /repository settings/i }),
  );

  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/terraform path/i), {
    target: { value: "" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: /save settings/i }));

  // An emptied path is a real change, not "leave it alone" — it must be sent.
  expect(updateRepositoryMock).toHaveBeenCalledWith("r1", { terraformPath: "" });
});

it("surfaces the last PR comment error on the card", async () => {
  listRepositoriesMock.mockResolvedValue([
    repo({ prCommentsEnabled: true, lastCommentError: "GitHub API 403: forbidden" }),
  ]);

  renderPage();

  expect(await screen.findByText(/last pr comment failed/i)).toBeInTheDocument();
});

it("removes a repository through a confirmation dialog", async () => {
  listRepositoriesMock.mockResolvedValue([repo()]);
  deleteRepositoryMock.mockResolvedValue(undefined);

  renderPage();
  await openMenu(/manage acme\/infra/i);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /remove repository/i }),
  );

  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: /^remove repository$/i }),
  );

  expect(deleteRepositoryMock).toHaveBeenCalledWith("r1");
  expect(await screen.findByText("No repositories yet")).toBeInTheDocument();
});

// --- Project-level actions (rec 6: destructive action, far from the CTA) -----

it("deletes the project from the header menu and navigates to the list", async () => {
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

  // No bare "Delete project" button beside the primary CTA any more.
  expect(
    await screen.findByRole("link", { name: /all projects/i }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Delete project" }),
  ).not.toBeInTheDocument();

  await openMenu(/project actions/i);
  fireEvent.click(await screen.findByRole("menuitem", { name: /delete project/i }));

  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/type the project name/i), {
    target: { value: "Prod Platform" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete project" }));

  expect(await screen.findByText("Projects list page")).toBeInTheDocument();
  expect(deleteProjectMock).toHaveBeenCalledWith("p1");
});
