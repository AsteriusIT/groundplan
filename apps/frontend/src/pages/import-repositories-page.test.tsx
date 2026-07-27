/**
 * The import screen (GP-230).
 *
 * The assertions that carry the story are about *refusing to proceed*: a
 * selected row with no type blocks the import, a monorepo is offered as two
 * imports rather than a mixed one, and a partial failure is shown as what it is
 * instead of being rounded up to success.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

let canManage = true;
vi.mock("@/rbac/use-can", () => ({ useCan: () => canManage }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    listProjects: vi.fn(),
    listProviderCatalog: vi.fn(),
    listConnections: vi.fn(),
    discoverRepositories: vi.fn(),
    detectRepositoryKinds: vi.fn(),
    importRepositories: vi.fn(),
  };
});

import {
  ApiError,
  detectRepositoryKinds,
  discoverRepositories,
  importRepositories,
  listConnections,
  listProjects,
  listProviderCatalog,
} from "@/api/client";
import type {
  DiscoveredRepository,
  Project,
  Provider,
  ProviderCatalogEntry,
  ProviderConnection,
  RepoKindDetection,
} from "@/api/types";
import { ImportRepositoriesPage } from "./import-repositories-page";

const projectsMock = vi.mocked(listProjects);
const catalogMock = vi.mocked(listProviderCatalog);
const connectionsMock = vi.mocked(listConnections);
const discoverMock = vi.mocked(discoverRepositories);
const detectMock = vi.mocked(detectRepositoryKinds);
const importMock = vi.mocked(importRepositories);

const project: Project = {
  id: "p1",
  name: "Platform",
  slug: "platform",
  contextMd: null,
  createdAt: "2026-07-01T00:00:00.000Z",
};

function repo(overrides: Partial<DiscoveredRepository> = {}): DiscoveredRepository {
  const name = overrides.name ?? "infra";
  return {
    externalId: overrides.externalId ?? name,
    fullName: `acme/${name}`,
    owner: "acme",
    name,
    cloneUrl: `https://github.com/acme/${name}.git`,
    defaultBranch: "main",
    private: true,
    archived: false,
    updatedAt: "2026-07-01T00:00:00.000Z",
    attachments: [],
    ...overrides,
  };
}

function detection(overrides: Partial<RepoKindDetection>): RepoKindDetection {
  return {
    fullName: "acme/infra",
    kind: "terraform",
    confidence: "high",
    evidence: ["main.tf"],
    suggestedPath: null,
    truncated: false,
    ...overrides,
  };
}

/** A provider entry as the backend registry reports it. */
function catalogEntry(
  id: Provider,
  label: string,
  discovers = true,
): ProviderCatalogEntry {
  return {
    id,
    label,
    capabilities: discovers ? ["repo:read", "repo:discover"] : ["repo:read"],
    credentialModes: ["pat"],
    connectableModes: [],
  };
}

function connectionFor(id: Provider): ProviderConnection {
  return {
    id: `c-${id}`,
    organizationId: "o1",
    provider: id,
    mode: "oauth2",
    name: id,
    config: { account: "acme" },
    status: "ok",
    lastError: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  canManage = true;
  projectsMock.mockReset().mockResolvedValue([project]);
  catalogMock.mockReset().mockResolvedValue([catalogEntry("github", "GitHub")]);
  connectionsMock.mockReset().mockResolvedValue([connectionFor("github")]);
  discoverMock.mockReset().mockResolvedValue({
    credentialId: "c1",
    repositories: [repo()],
    nextCursor: null,
    total: 1,
  });
  detectMock.mockReset().mockResolvedValue({ detections: [detection({})] });
  importMock.mockReset().mockResolvedValue({ imported: [], skipped: [], failed: [] });
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/import"]}>
      <ImportRepositoriesPage />
    </MemoryRouter>,
  );
}

it("lists what the installation reaches, with branch and visibility", async () => {
  discoverMock.mockResolvedValue({
    credentialId: "c1",
    repositories: [repo({ name: "infra", defaultBranch: "trunk" })],
    nextCursor: null,
    total: 1,
  });
  renderPage();

  expect(await screen.findByText("acme/infra")).toBeInTheDocument();
  expect(screen.getByText("trunk")).toBeInTheDocument();
  expect(screen.getByLabelText("Private")).toBeInTheDocument();
});

it("marks an already-imported repository, naming the types in use", async () => {
  discoverMock.mockResolvedValue({
    credentialId: "c1",
    repositories: [
      repo({
        attachments: [
          { repoId: "r1", projectId: "p1", kind: "terraform", path: "infra" },
        ],
      }),
    ],
    nextCursor: null,
    total: 1,
  });
  renderPage();

  expect(await screen.findByText(/Already imported · Terraform/)).toBeInTheDocument();
  // …and it stays selectable: a second attachment with another type is legitimate.
  expect(screen.getByLabelText("Select acme/infra")).toBeEnabled();
});

it("pre-fills the type only when detection is confident", async () => {
  discoverMock.mockResolvedValue({
    credentialId: "c1",
    repositories: [repo({ name: "infra" }), repo({ name: "mystery" })],
    nextCursor: null,
    total: 2,
  });
  detectMock.mockResolvedValue({
    detections: [
      detection({ fullName: "acme/infra", kind: "terraform", confidence: "high" }),
      detection({
        fullName: "acme/mystery",
        kind: null,
        confidence: "low",
        evidence: [],
      }),
    ],
  });
  renderPage();

  fireEvent.click(await screen.findByLabelText("Select acme/infra"));
  const confident = screen.getByRole("group", { name: "Type for acme/infra" });
  await waitFor(() =>
    expect(
      within(confident).getByRole("button", { name: "Terraform" }),
    ).toHaveAttribute("aria-pressed", "true"),
  );
  expect(screen.getByText("detected")).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("Select acme/mystery"));
  const uncertain = screen.getByRole("group", { name: "Type for acme/mystery" });
  expect(
    within(uncertain).getByRole("button", { name: "Terraform" }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(
    within(uncertain).getByRole("button", { name: "Kubernetes" }),
  ).toHaveAttribute("aria-pressed", "false");
});

it("refuses to import while a selected row has no type", async () => {
  detectMock.mockResolvedValue({
    detections: [detection({ kind: null, confidence: "low", evidence: [] })],
  });
  renderPage();

  fireEvent.click(await screen.findByLabelText("Select acme/infra"));
  const button = screen.getByTestId("import-submit");
  expect(button).toBeDisabled();
  expect(screen.getByText(/needs a type/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  await waitFor(() => expect(button).toBeEnabled());
});

it("says the type is permanent before the import, not after", async () => {
  renderPage();
  expect(
    await screen.findByText(/cannot be changed after the import/i),
  ).toBeInTheDocument();
});

it("offers a monorepo as two imports, never as a mixed type", async () => {
  detectMock.mockResolvedValue({
    detections: [
      detection({
        kind: null,
        confidence: "low",
        evidence: ["infra/main.tf", "k8s/deploy.yaml"],
      }),
    ],
  });
  renderPage();

  fireEvent.click(await screen.findByLabelText("Select acme/infra"));
  expect(
    await screen.findByText(/holds both Terraform and manifests/i),
  ).toBeInTheDocument();
  // There is no third option offered anywhere.
  expect(screen.queryByRole("button", { name: /both/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Terraform" }));
  fireEvent.click(screen.getByRole("button", { name: "Import twice" }));
  await waitFor(() =>
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 selected"),
  );
});

it("sends the chosen type and path for every selected row", async () => {
  detectMock.mockResolvedValue({
    detections: [detection({ suggestedPath: "infra" })],
  });
  renderPage();

  fireEvent.click(await screen.findByLabelText("Select acme/infra"));
  await waitFor(() =>
    expect(screen.getByLabelText("Path for acme/infra")).toHaveValue("infra"),
  );
  fireEvent.click(screen.getByTestId("import-submit"));

  await waitFor(() => expect(importMock).toHaveBeenCalled());
  expect(importMock).toHaveBeenCalledWith({
    projectId: "p1",
    // The connection that listed the repository is the one that should
    // authenticate the clone — no re-deriving it from the URL.
    credentialId: "c1",
    items: [
      {
        cloneUrl: "https://github.com/acme/infra.git",
        kind: "terraform",
        path: "infra",
        defaultBranch: "main",
      },
    ],
  });
});

it("reports a partial import as what it is, and retries only the failures", async () => {
  discoverMock.mockResolvedValue({
    credentialId: "c1",
    repositories: [repo({ name: "one" }), repo({ name: "two" })],
    nextCursor: null,
    total: 2,
  });
  detectMock.mockResolvedValue({
    detections: [
      detection({ fullName: "acme/one" }),
      detection({ fullName: "acme/two" }),
    ],
  });
  importMock.mockResolvedValue({
    imported: [],
    skipped: [{ item: { cloneUrl: "x", kind: "terraform" }, reason: "already attached" }],
    failed: [
      {
        item: { cloneUrl: "https://github.com/acme/two.git", kind: "terraform" },
        error: "no credential could be resolved",
        code: "no_credential_resolved",
      },
    ],
  });
  renderPage();

  fireEvent.click(await screen.findByLabelText("Select acme/one"));
  fireEvent.click(screen.getByLabelText("Select acme/two"));
  await waitFor(() =>
    expect(screen.getByTestId("import-submit")).toBeEnabled(),
  );
  fireEvent.click(screen.getByTestId("import-submit"));

  expect(
    await screen.findByText(/0 imported · 1 already attached · 1 failed/),
  ).toBeInTheDocument();
  expect(screen.getByText(/no credential could be resolved/)).toBeInTheDocument();

  // Only the failure is still selected, so "retry" means "retry that one".
  await waitFor(() =>
    expect(screen.getByTestId("selection-count")).toHaveTextContent("1 selected"),
  );
});

it("names a revoked installation and how to fix it, never an empty list", async () => {
  discoverMock.mockRejectedValue(
    new ApiError(
      422,
      "the GitHub App installation is no longer available",
      undefined,
      "installation_revoked",
    ),
  );
  renderPage();

  expect(await screen.findByRole("alert")).toHaveTextContent(/no longer available/);
  expect(screen.getByText(/Reconnect the GitHub App/)).toBeInTheDocument();
});

it("an installation covering nothing says so, distinctly from a failure", async () => {
  discoverMock.mockResolvedValue({
    credentialId: "c1",
    repositories: [],
    nextCursor: null,
    total: 0,
  });
  renderPage();

  expect(
    await screen.findByText(/does not cover any repository/i),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("searches on the server, debounced, over the whole installation", async () => {
  renderPage();
  await waitFor(() => expect(discoverMock).toHaveBeenCalled());
  discoverMock.mockClear();

  // Three keystrokes in quick succession must cost one request, not three:
  // the search is answered over the whole installation, which is not free.
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "n" } });
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "nee" } });
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "needle" } });

  await waitFor(() =>
    expect(discoverMock).toHaveBeenCalledWith("github", { search: "needle" }),
  );
  expect(discoverMock).toHaveBeenCalledTimes(1);
});

it("is closed to a member, like every other repository change", async () => {
  canManage = false;
  renderPage();
  expect(
    await screen.findByText(/An admin can import repositories/),
  ).toBeInTheDocument();
  expect(discoverMock).not.toHaveBeenCalled();
});

// --- GP-232: the screen reads the provider, it does not assume one ----------

it("imports from the org's single importable provider, whichever it is", async () => {
  catalogMock.mockResolvedValue([catalogEntry("gitlab", "GitLab")]);
  connectionsMock.mockResolvedValue([connectionFor("gitlab")]);
  renderPage();

  await waitFor(() =>
    expect(discoverMock).toHaveBeenCalledWith("gitlab", { search: "" }),
  );
  // The copy follows the provider too — no "GitHub" left in a GitLab screen.
  expect(await screen.findByText(/GitLab connection can reach/i)).toBeInTheDocument();
  expect(screen.queryByText(/GitHub/)).not.toBeInTheDocument();
});

it("offers a choice only when there is one, and switches on it", async () => {
  catalogMock.mockResolvedValue([
    catalogEntry("github", "GitHub"),
    catalogEntry("gitlab", "GitLab"),
  ]);
  connectionsMock.mockResolvedValue([
    connectionFor("github"),
    connectionFor("gitlab"),
  ]);
  renderPage();

  const picker = await screen.findByRole("group", { name: "Provider" });
  expect(within(picker).getByRole("button", { name: "GitHub" })).toBeInTheDocument();

  fireEvent.click(within(picker).getByRole("button", { name: "GitLab" }));
  await waitFor(() =>
    expect(discoverMock).toHaveBeenCalledWith("gitlab", { search: "" }),
  );
});

it("shows no provider switch when only one provider can import", async () => {
  renderPage();
  await screen.findByText("acme/infra");
  expect(screen.queryByRole("group", { name: "Provider" })).not.toBeInTheDocument();
});

it("honours ?provider= so a settings row opens on the row you clicked", async () => {
  catalogMock.mockResolvedValue([
    catalogEntry("github", "GitHub"),
    catalogEntry("gitlab", "GitLab"),
  ]);
  connectionsMock.mockResolvedValue([
    connectionFor("github"),
    connectionFor("gitlab"),
  ]);
  render(
    <MemoryRouter initialEntries={["/import?provider=gitlab"]}>
      <ImportRepositoriesPage />
    </MemoryRouter>,
  );

  await waitFor(() =>
    expect(discoverMock).toHaveBeenCalledWith("gitlab", { search: "" }),
  );
});

it("never carries a selection from one provider to the other", async () => {
  catalogMock.mockResolvedValue([
    catalogEntry("github", "GitHub"),
    catalogEntry("gitlab", "GitLab"),
  ]);
  connectionsMock.mockResolvedValue([
    connectionFor("github"),
    connectionFor("gitlab"),
  ]);
  renderPage();

  fireEvent.click(await screen.findByLabelText("Select acme/infra"));
  await waitFor(() =>
    expect(screen.getByTestId("selection-count")).toHaveTextContent("1 selected"),
  );

  const picker = screen.getByRole("group", { name: "Provider" });
  fireEvent.click(within(picker).getByRole("button", { name: "GitLab" }));

  // Importing GitHub rows while showing GitLab ones would look entirely normal
  // — including the counter. It must start over.
  await waitFor(() =>
    expect(screen.getByTestId("selection-count")).toHaveTextContent("0 selected"),
  );
});

it("says so when nothing connected can list repositories", async () => {
  catalogMock.mockResolvedValue([catalogEntry("github", "GitHub", false)]);
  connectionsMock.mockResolvedValue([connectionFor("github")]);
  renderPage();

  expect(
    await screen.findByText(/No connected provider on this instance can list/i),
  ).toBeInTheDocument();
  expect(discoverMock).not.toHaveBeenCalled();
});

it("says so when a capable provider has no connection", async () => {
  catalogMock.mockResolvedValue([catalogEntry("github", "GitHub")]);
  connectionsMock.mockResolvedValue([]);
  renderPage();

  expect(
    await screen.findByText(/No connected provider on this instance can list/i),
  ).toBeInTheDocument();
});
