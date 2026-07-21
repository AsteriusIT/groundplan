import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getConfluenceConnection: vi.fn(),
    saveConfluenceConnection: vi.fn(),
    verifyConfluenceConnection: vi.fn(),
    deleteConfluenceConnection: vi.fn(),
  };
});

import {
  deleteConfluenceConnection,
  getConfluenceConnection,
  saveConfluenceConnection,
  verifyConfluenceConnection,
} from "@/api/client";
import type { ConfluenceConnection, Repository } from "@/api/types";
import { ConfluenceSettingsDialog } from "./confluence-settings-dialog";

const getMock = vi.mocked(getConfluenceConnection);
const saveMock = vi.mocked(saveConfluenceConnection);
const verifyMock = vi.mocked(verifyConfluenceConnection);
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

const connection: ConfluenceConnection = {
  id: "c1",
  repositoryId: "r1",
  baseUrl: "https://acme.atlassian.net/wiki",
  spaceKey: "DOCS",
  authType: "cloud_token",
  email: "docs@acme.test",
  credential: "***",
  connectionStatus: "ok",
  verifiedAt: "2026-07-20T10:00:00Z",
  pageUrl: null,
  lastPublishedAt: null,
  lastPublishError: null,
  createdAt: "2026-07-01T00:00:00Z",
};

beforeEach(() => {
  getMock.mockReset().mockResolvedValue(null);
  saveMock.mockReset();
  verifyMock.mockReset();
  deleteMock.mockReset();
});

function renderDialog() {
  return render(
    <main>
      <ConfluenceSettingsDialog
        repository={repo}
        open
        onOpenChange={() => {}}
      />
    </main>,
  );
}

it("creates a Cloud connection: email + API token, verified on save", async () => {
  saveMock.mockResolvedValue({ ...connection, connectionStatus: "ok" });
  renderDialog();

  fireEvent.change(await screen.findByLabelText(/base url/i), {
    target: { value: "https://acme.atlassian.net/wiki" },
  });
  fireEvent.change(screen.getByLabelText(/space key/i), {
    target: { value: "DOCS" },
  });
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "docs@acme.test" },
  });
  fireEvent.change(screen.getByLabelText(/api token/i), {
    target: { value: "secret-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(saveMock).toHaveBeenCalledWith("r1", {
      baseUrl: "https://acme.atlassian.net/wiki",
      spaceKey: "DOCS",
      authType: "cloud_token",
      email: "docs@acme.test",
      credential: "secret-token",
    }),
  );
  // The save auto-verifies; the outcome is shown, not hidden behind a close.
  expect(await screen.findByText(/connected/i)).toBeInTheDocument();
});

it("a DC PAT needs no email, and the credential field says PAT", async () => {
  saveMock.mockResolvedValue({
    ...connection,
    authType: "dc_pat",
    email: null,
    baseUrl: "https://confluence.acme.test",
  });
  renderDialog();

  fireEvent.click(
    await screen.findByRole("button", { name: /data center pat/i }),
  );
  expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/base url/i), {
    target: { value: "https://confluence.acme.test" },
  });
  fireEvent.change(screen.getByLabelText(/space key/i), {
    target: { value: "OPS" },
  });
  fireEvent.change(screen.getByLabelText(/personal access token/i), {
    target: { value: "dc-pat" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(saveMock).toHaveBeenCalledWith("r1", {
      baseUrl: "https://confluence.acme.test",
      spaceKey: "OPS",
      authType: "dc_pat",
      credential: "dc-pat",
    }),
  );
});

it("an existing connection seeds the form; a blank credential means keep it", async () => {
  getMock.mockResolvedValue(connection);
  saveMock.mockResolvedValue({ ...connection, spaceKey: "OPS" });
  renderDialog();

  const baseUrl = await screen.findByLabelText(/base url/i);
  expect(baseUrl).toHaveValue("https://acme.atlassian.net/wiki");
  // Write-only: the stored credential is never displayed back.
  const credential = screen.getByLabelText(/replace api token/i);
  expect(credential).toHaveValue("");
  expect(credential).toHaveAttribute("placeholder", "••••••••");
  expect(screen.getByText(/leave this blank to keep it/i)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/space key/i), {
    target: { value: "OPS" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() =>
    expect(saveMock).toHaveBeenCalledWith("r1", {
      baseUrl: "https://acme.atlassian.net/wiki",
      spaceKey: "OPS",
      authType: "cloud_token",
      email: "docs@acme.test",
    }),
  );
});

it("verify reports the categorized reason in words", async () => {
  getMock.mockResolvedValue(connection);
  verifyMock.mockResolvedValue({ ok: false, error: "space_not_found" });
  renderDialog();

  fireEvent.click(await screen.findByRole("button", { name: /^verify$/i }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/space was not found/i);
});

it("a save that fails verification says why, not just that it failed", async () => {
  saveMock.mockResolvedValue({ ...connection, connectionStatus: "failed" });
  verifyMock.mockResolvedValue({ ok: false, error: "auth_failed" });
  renderDialog();

  fireEvent.change(await screen.findByLabelText(/base url/i), {
    target: { value: "https://acme.atlassian.net/wiki" },
  });
  fireEvent.change(screen.getByLabelText(/space key/i), {
    target: { value: "DOCS" },
  });
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "docs@acme.test" },
  });
  fireEvent.change(screen.getByLabelText(/api token/i), {
    target: { value: "wrong" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/rejected the credential/i);
});

it("has no axe violations", async () => {
  getMock.mockResolvedValue(connection);
  const { baseElement } = renderDialog();
  await screen.findByLabelText(/base url/i);
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
