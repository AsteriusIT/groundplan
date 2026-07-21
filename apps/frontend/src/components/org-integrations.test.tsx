import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    listIntegrations: vi.fn(),
    createIntegration: vi.fn(),
    updateIntegration: vi.fn(),
    verifyIntegration: vi.fn(),
    deleteIntegration: vi.fn(),
  };
});

let canManage = true;
vi.mock("@/rbac/use-can", () => ({ useCan: () => canManage }));

import {
  ApiError,
  createIntegration,
  deleteIntegration,
  listIntegrations,
  updateIntegration,
  verifyIntegration,
} from "@/api/client";
import type { Integration } from "@/api/types";
import { OrgIntegrations } from "./org-integrations";

const listMock = vi.mocked(listIntegrations);
const createMock = vi.mocked(createIntegration);
const updateMock = vi.mocked(updateIntegration);
const verifyMock = vi.mocked(verifyIntegration);
const deleteMock = vi.mocked(deleteIntegration);

function integration(over: Partial<Integration> = {}): Integration {
  return {
    id: "i1",
    organizationId: "o1",
    type: "atlassian",
    name: "Acme Cloud",
    config: {
      baseUrl: "https://acme.atlassian.net/wiki",
      authType: "cloud_token",
      email: "docs@acme.test",
    },
    credential: "***",
    connectionStatus: "ok",
    verifiedAt: "2026-07-20T10:00:00Z",
    createdAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  canManage = true;
  listMock.mockReset().mockResolvedValue([]);
  createMock.mockReset();
  updateMock.mockReset();
  verifyMock.mockReset();
  deleteMock.mockReset();
});

it("a member sees the list read-only — no manage actions", async () => {
  canManage = false;
  listMock.mockResolvedValue([integration()]);
  render(<OrgIntegrations />);

  expect(await screen.findByText("Acme Cloud")).toBeInTheDocument();
  expect(
    screen.getByText("https://acme.atlassian.net/wiki"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /add integration/i }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^verify$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
});

it("an owner/admin adds a Cloud Atlassian integration", async () => {
  const created = integration({ id: "i9", name: "New Site" });
  createMock.mockResolvedValue(created);
  render(<OrgIntegrations />);

  fireEvent.click(await screen.findByRole("button", { name: /add integration/i }));
  fireEvent.change(screen.getByLabelText(/^name$/i), {
    target: { value: "New Site" },
  });
  fireEvent.change(screen.getByLabelText(/base url/i), {
    target: { value: "https://acme.atlassian.net/wiki" },
  });
  fireEvent.change(screen.getByLabelText(/account email/i), {
    target: { value: "docs@acme.test" },
  });
  fireEvent.change(screen.getByLabelText(/api token/i), {
    target: { value: "secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^add integration$/i }));

  await waitFor(() =>
    expect(createMock).toHaveBeenCalledWith({
      type: "atlassian",
      name: "New Site",
      baseUrl: "https://acme.atlassian.net/wiki",
      authType: "cloud_token",
      email: "docs@acme.test",
      credential: "secret",
    }),
  );
  expect(await screen.findByText("New Site")).toBeInTheDocument();
});

it("a DC PAT needs no email and sends none", async () => {
  createMock.mockResolvedValue(integration({ id: "i9", name: "DC" }));
  render(<OrgIntegrations />);

  fireEvent.click(await screen.findByRole("button", { name: /add integration/i }));
  fireEvent.click(screen.getByRole("button", { name: /data center pat/i }));
  expect(screen.queryByLabelText(/account email/i)).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "DC" } });
  fireEvent.change(screen.getByLabelText(/base url/i), {
    target: { value: "https://confluence.acme.test" },
  });
  fireEvent.change(screen.getByLabelText(/personal access token/i), {
    target: { value: "dc-pat" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^add integration$/i }));

  await waitFor(() =>
    expect(createMock).toHaveBeenCalledWith({
      type: "atlassian",
      name: "DC",
      baseUrl: "https://confluence.acme.test",
      authType: "dc_pat",
      credential: "dc-pat",
    }),
  );
});

it("edit seeds the form and omits a blank credential (keep the stored one)", async () => {
  listMock.mockResolvedValue([integration()]);
  updateMock.mockResolvedValue(integration({ name: "Renamed" }));
  render(<OrgIntegrations />);

  fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  const name = screen.getByLabelText(/^name$/i);
  expect(name).toHaveValue("Acme Cloud");
  // Write-only: the stored credential is never shown back.
  expect(screen.getByLabelText(/replace api token/i)).toHaveValue("");

  fireEvent.change(name, { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

  await waitFor(() =>
    expect(updateMock).toHaveBeenCalledWith("i1", {
      name: "Renamed",
      baseUrl: "https://acme.atlassian.net/wiki",
      authType: "cloud_token",
      email: "docs@acme.test",
    }),
  );
});

it("verify shows the categorized reason in words", async () => {
  listMock.mockResolvedValue([integration()]);
  verifyMock.mockResolvedValue({ ok: false, error: "auth_failed" });
  render(<OrgIntegrations />);

  fireEvent.click(await screen.findByRole("button", { name: /^verify$/i }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/rejected the credential/i);
});

it("a delete blocked by a referencing repository explains why", async () => {
  listMock.mockResolvedValue([integration()]);
  deleteMock.mockRejectedValue(
    new ApiError(
      409,
      "this integration is used by one or more repositories — remove those Confluence targets first",
    ),
  );
  render(<OrgIntegrations />);

  fireEvent.click(await screen.findByRole("button", { name: /delete acme cloud/i }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/used by one or more repositories/i);
  // Still listed — the delete did not go through.
  expect(screen.getByText("Acme Cloud")).toBeInTheDocument();
});

it("has no axe violations", async () => {
  listMock.mockResolvedValue([integration()]);
  const { baseElement } = render(
    <main>
      <OrgIntegrations />
    </main>,
  );
  await screen.findByText("Acme Cloud");
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
