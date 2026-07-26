/**
 * Provider connections in the org settings (GP-198). The list is generated from
 * the backend catalog, so the assertions here are about *that* — a provider the
 * backend adds shows up, and one this instance cannot connect says so instead of
 * offering a button that would fail.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    listProviderCatalog: vi.fn(),
    listConnections: vi.fn(),
    startConnection: vi.fn(),
    connectionImpact: vi.fn(),
    revokeConnection: vi.fn(),
  };
});

let canManage = true;
vi.mock("@/rbac/use-can", () => ({ useCan: () => canManage }));

import {
  connectionImpact,
  listConnections,
  listProviderCatalog,
  revokeConnection,
  startConnection,
} from "@/api/client";
import type { ProviderCatalogEntry, ProviderConnection } from "@/api/types";
import { OrgConnections } from "./org-connections";

const catalogMock = vi.mocked(listProviderCatalog);
const connectionsMock = vi.mocked(listConnections);
const startMock = vi.mocked(startConnection);
const impactMock = vi.mocked(connectionImpact);
const revokeMock = vi.mocked(revokeConnection);

const GITHUB: ProviderCatalogEntry = {
  id: "github",
  label: "GitHub",
  capabilities: ["repo:read", "pr:comment", "ref:events"],
  credentialModes: ["installation_app", "pat"],
  connectableModes: ["installation_app"],
};

const GENERIC: ProviderCatalogEntry = {
  id: "generic",
  label: "Git (generic)",
  capabilities: ["repo:read"],
  credentialModes: ["pat"],
  connectableModes: [],
};

function connection(over: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: "c1",
    organizationId: "o1",
    provider: "github",
    mode: "installation_app",
    name: "acme-corp",
    config: { installationId: 42 },
    status: "ok",
    lastError: null,
    createdAt: "2026-07-26T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  canManage = true;
  catalogMock.mockReset().mockResolvedValue([GITHUB, GENERIC]);
  connectionsMock.mockReset().mockResolvedValue([]);
  startMock.mockReset();
  impactMock.mockReset().mockResolvedValue({ repositories: [] });
  revokeMock.mockReset().mockResolvedValue(undefined);
});

it("renders one row per provider the backend reports, hardcoding none", async () => {
  render(<OrgConnections />);

  expect(await screen.findByText("GitHub")).toBeInTheDocument();
  expect(screen.getByText("Git (generic)")).toBeInTheDocument();
});

it("offers Connect where this instance can, and says so where it cannot", async () => {
  render(<OrgConnections />);

  expect(await screen.findByRole("button", { name: /^connect$/i })).toBeInTheDocument();
  expect(screen.getByText(/token only on this instance/i)).toBeInTheDocument();
  expect(screen.getByText("Not configured")).toBeInTheDocument();
});

it("sends the browser to the provider when connecting", async () => {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    value: { assign },
    writable: true,
  });
  startMock.mockResolvedValue({
    authorizeUrl: "https://github.com/apps/groundplan/installations/new?state=x",
    redirectUri: "https://gp.example.com/integrations/callback",
  });

  render(<OrgConnections />);
  fireEvent.click(await screen.findByRole("button", { name: /^connect$/i }));

  await waitFor(() =>
    expect(startMock).toHaveBeenCalledWith({
      provider: "github",
      mode: "installation_app",
    }),
  );
  expect(assign).toHaveBeenCalledWith(
    "https://github.com/apps/groundplan/installations/new?state=x",
  );
});

it("shows a connected provider with its account and how it authenticates", async () => {
  connectionsMock.mockResolvedValue([connection()]);

  render(<OrgConnections />);

  expect(await screen.findByText(/acme-corp · App installation/)).toBeInTheDocument();
  expect(screen.getByText("Connected")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /reconnect/i })).toBeInTheDocument();
});

it("says when a connection needs a human, with the reason", async () => {
  connectionsMock.mockResolvedValue([
    connection({
      status: "reconnect_required",
      lastError: "the provider rejected the stored authorization",
    }),
  ]);

  render(<OrgConnections />);

  expect(await screen.findByText("Reconnect required")).toBeInTheDocument();
  expect(
    screen.getByText(/the provider rejected the stored authorization/),
  ).toBeInTheDocument();
});

it("lists the repositories a revocation would degrade before confirming", async () => {
  connectionsMock.mockResolvedValue([connection()]);
  impactMock.mockResolvedValue({
    repositories: [{ id: "r1", url: "https://github.com/acme/infra" }],
  });

  render(<OrgConnections />);
  fireEvent.click(await screen.findByRole("button", { name: /revoke/i }));

  expect(await screen.findByText("https://github.com/acme/infra")).toBeInTheDocument();
  expect(screen.getByText(/falls back to its own access token/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
  await waitFor(() => expect(revokeMock).toHaveBeenCalledWith("c1"));
});

it("a member sees the list but none of the management actions", async () => {
  canManage = false;
  connectionsMock.mockResolvedValue([connection()]);

  render(<OrgConnections />);

  expect(await screen.findByText("GitHub")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /reconnect/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument();
});

it("has no axe violations", async () => {
  connectionsMock.mockResolvedValue([connection()]);
  const { baseElement } = render(
    <main>
      <OrgConnections />
    </main>,
  );
  await screen.findByText("GitHub");
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
