import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getConfluenceConnection: vi.fn(),
    listIntegrations: vi.fn(),
    saveConfluenceConnection: vi.fn(),
    deleteConfluenceConnection: vi.fn(),
  };
});

let canManageIntegrations = true;
vi.mock("@/rbac/use-can", () => ({ useCan: () => canManageIntegrations }));

import {
  deleteConfluenceConnection,
  getConfluenceConnection,
  listIntegrations,
  saveConfluenceConnection,
} from "@/api/client";
import type { ConfluenceConnection, Integration, Repository } from "@/api/types";
import { ConfluenceSettingsDialog } from "./confluence-settings-dialog";

const getMock = vi.mocked(getConfluenceConnection);
const listMock = vi.mocked(listIntegrations);
const saveMock = vi.mocked(saveConfluenceConnection);
const deleteMock = vi.mocked(deleteConfluenceConnection);

const repo: Repository = {
  id: "r1",
  projectId: "p1",
  provider: "github",
  iacType: "terraform",
  url: "https://github.com/acme/infra",
  defaultBranch: "main",
  accessToken: null,
  connectionStatus: "ok",
  verifiedAt: null,
  prCommentsEnabled: false,
  lastCommentError: null,
  contextMd: null,
  terraformPath: "",
  createdAt: "2026-07-01T00:00:00Z",
};

function integration(overrides: Partial<Integration> = {}): Integration {
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
    ...overrides,
  };
}

const connection: ConfluenceConnection = {
  id: "c1",
  repositoryId: "r1",
  integrationId: "i2",
  spaceKey: "DOCS",
  pageUrl: null,
  lastPublishedAt: null,
  lastPublishError: null,
  createdAt: "2026-07-01T00:00:00Z",
};

beforeEach(() => {
  canManageIntegrations = true;
  getMock.mockReset().mockResolvedValue(null);
  listMock.mockReset().mockResolvedValue([]);
  saveMock.mockReset();
  deleteMock.mockReset();
});

function renderDialog() {
  return render(
    <MemoryRouter>
      <main>
        <ConfluenceSettingsDialog repository={repo} open onOpenChange={() => {}} />
      </main>
    </MemoryRouter>,
  );
}

it("with no integration, a manager sees the org-settings set-up hint", async () => {
  renderDialog();
  expect(await screen.findByText(/no atlassian integration yet/i)).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /set one up in organization settings/i }),
  ).toBeInTheDocument();
});

it("with no integration, a member sees no set-up action", async () => {
  canManageIntegrations = false;
  renderDialog();
  expect(
    await screen.findByText(/no atlassian integration is configured/i),
  ).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("picks an integration and a space key, then saves the target — no credential", async () => {
  listMock.mockResolvedValue([
    integration({ id: "i1", name: "Acme Cloud" }),
    integration({ id: "i2", name: "Acme DC", config: {
      baseUrl: "https://confluence.acme.test", authType: "dc_pat", email: null,
    } }),
  ]);
  saveMock.mockResolvedValue({ ...connection, integrationId: "i2", spaceKey: "OPS" });
  renderDialog();

  const select = await screen.findByLabelText(/atlassian integration/i);
  fireEvent.change(select, { target: { value: "i2" } });
  fireEvent.change(screen.getByLabelText(/space key/i), {
    target: { value: "OPS" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save target/i }));

  await waitFor(() =>
    expect(saveMock).toHaveBeenCalledWith("r1", {
      integrationId: "i2",
      spaceKey: "OPS",
    }),
  );
});

it("an existing target seeds its integration and space key, and can be removed", async () => {
  getMock.mockResolvedValue(connection);
  listMock.mockResolvedValue([
    integration({ id: "i1", name: "Acme Cloud" }),
    integration({ id: "i2", name: "Acme DC" }),
  ]);
  deleteMock.mockResolvedValue();
  renderDialog();

  const select = (await screen.findByLabelText(
    /atlassian integration/i,
  )) as HTMLSelectElement;
  expect(select.value).toBe("i2");
  expect(screen.getByLabelText(/space key/i)).toHaveValue("DOCS");

  fireEvent.click(screen.getByRole("button", { name: /remove target/i }));
  await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("r1"));
});

it("has no axe violations", async () => {
  getMock.mockResolvedValue(connection);
  listMock.mockResolvedValue([integration({ id: "i2", name: "Acme DC" })]);
  const { baseElement } = renderDialog();
  await screen.findByLabelText(/atlassian integration/i);
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
