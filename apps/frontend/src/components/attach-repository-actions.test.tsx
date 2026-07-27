/**
 * The two branches of attaching (GP-231): import is the road, URL is the
 * detour. Which one exists is read from the registry, never assumed.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    listConnections: vi.fn(),
    listProviderCatalog: vi.fn(),
    createRepository: vi.fn(),
  };
});

import { listConnections, listProviderCatalog } from "@/api/client";
import type { ProviderCatalogEntry, ProviderConnection } from "@/api/types";
import { AttachRepositoryActions } from "./attach-repository-actions";

const connectionsMock = vi.mocked(listConnections);
const catalogMock = vi.mocked(listProviderCatalog);

const githubConnection: ProviderConnection = {
  id: "c1",
  organizationId: "o1",
  provider: "github",
  mode: "installation_app",
  name: "acme",
  config: { installationId: 42, account: "acme" },
  status: "ok",
  lastError: null,
  createdAt: "2026-07-01T00:00:00.000Z",
};

function catalog(capabilities: ProviderCatalogEntry["capabilities"]): ProviderCatalogEntry[] {
  return [
    {
      id: "github",
      label: "GitHub",
      capabilities,
      credentialModes: ["installation_app", "pat"],
      connectableModes: ["installation_app"],
    },
  ];
}

beforeEach(() => {
  connectionsMock.mockReset().mockResolvedValue([]);
  catalogMock.mockReset().mockResolvedValue(catalog(["repo:read", "repo:discover"]));
});

function renderActions() {
  render(
    <MemoryRouter>
      <AttachRepositoryActions projectId="p1" onAttached={vi.fn()} />
    </MemoryRouter>,
  );
}

it("leads with import when a connection can list repositories", async () => {
  connectionsMock.mockResolvedValue([githubConnection]);
  renderActions();

  const importLink = await screen.findByRole("link", { name: /import from github/i });
  expect(importLink).toHaveAttribute("href", "/import?project=p1");
  // The URL path is still there, demoted to secondary.
  expect(screen.getByRole("button", { name: /attach by url/i })).toBeInTheDocument();
});

it("offers only the URL path when nothing is connected", async () => {
  connectionsMock.mockResolvedValue([]);
  renderActions();

  expect(
    await screen.findByRole("button", { name: /attach repository/i }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /import from github/i }),
  ).not.toBeInTheDocument();
});

it("does not offer import for a connection whose provider cannot discover", async () => {
  // A deployment with a connection but no discovery capability must not show a
  // button that could only ever 422.
  connectionsMock.mockResolvedValue([githubConnection]);
  catalogMock.mockResolvedValue(catalog(["repo:read", "pr:comment"]));
  renderActions();

  await waitFor(() =>
    expect(screen.getByRole("button", { name: /attach repository/i })).toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("link", { name: /import from github/i }),
  ).not.toBeInTheDocument();
});
