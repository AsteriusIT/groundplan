import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    createRepository: vi.fn(),
    verifyRepository: vi.fn(),
  };
});

import { createRepository, verifyRepository } from "@/api/client";
import type { CreatedRepository } from "@/api/types";
import { AttachRepositoryDialog } from "./attach-repository-dialog";

const createMock = vi.mocked(createRepository);
const verifyMock = vi.mocked(verifyRepository);

const created: CreatedRepository = {
  id: "r1",
  projectId: "p1",
  provider: "gitlab",
  url: "https://gitlab.com/acme/infra",
  defaultBranch: "main",
  accessToken: null,
  connectionStatus: "ok",
  verifiedAt: null,
  prCommentsEnabled: false,
  lastCommentError: null,
  contextMd: null,
  terraformPath: "",
  createdAt: "2026-07-11T00:00:00.000Z",
  webhookToken: "wh-secret",
};

beforeEach(() => {
  createMock.mockReset().mockResolvedValue(created);
  verifyMock.mockReset().mockResolvedValue({ ok: true, default_branch_found: true });
});

function open() {
  render(
    <AttachRepositoryDialog
      projectId="p1"
      trigger={<button>Open</button>}
      onAttached={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
}

async function typeUrl(value: string) {
  fireEvent.change(await screen.findByLabelText("Repository URL"), {
    target: { value },
  });
}

it("detects the provider live from the URL as it is typed", async () => {
  open();

  await typeUrl("https://gitlab.com/acme/infra");
  expect(screen.getByTestId("provider-chip")).toHaveTextContent("GitLab");

  await typeUrl("https://dev.azure.com/acme/infra/_git/repo");
  expect(screen.getByTestId("provider-chip")).toHaveTextContent("Azure DevOps");

  await typeUrl("https://git.internal.example.com/acme/infra.git");
  expect(screen.getByTestId("provider-chip")).toHaveTextContent("Generic");

  await typeUrl("https://github.com/acme/infra");
  expect(screen.getByTestId("provider-chip")).toHaveTextContent("GitHub");
});

it("a manual override wins over detection and persists across URL edits", async () => {
  open();

  await typeUrl("https://github.com/acme/infra");
  expect(screen.getByTestId("provider-chip")).toHaveTextContent("GitHub");

  fireEvent.change(screen.getByLabelText("Provider"), {
    target: { value: "gitlab" },
  });
  expect(screen.getByTestId("provider-chip")).toHaveTextContent("GitLab");

  // Changing the URL must NOT clobber the explicit override.
  await typeUrl("https://dev.azure.com/acme/infra/_git/repo");
  expect(screen.getByTestId("provider-chip")).toHaveTextContent("GitLab");
});

it("shows per-provider PAT help that switches with the provider", async () => {
  open();

  await typeUrl("https://github.com/acme/infra");
  expect(screen.getByText(/Contents: Read/i)).toBeInTheDocument();

  await typeUrl("https://gitlab.com/acme/infra");
  expect(screen.getByText(/read_repository/i)).toBeInTheDocument();

  await typeUrl("https://dev.azure.com/acme/infra/_git/repo");
  expect(screen.getByText(/Code \(Read\)/i)).toBeInTheDocument();
});

it("submits with the overridden provider", async () => {
  open();

  await typeUrl("https://github.com/acme/infra");
  fireEvent.change(screen.getByLabelText("Provider"), {
    target: { value: "gitlab" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^attach repository$/i }));

  await waitFor(() =>
    expect(createMock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ provider: "gitlab", url: "https://github.com/acme/infra" }),
    ),
  );
});

it("submits the auto-detected provider when not overridden", async () => {
  open();

  await typeUrl("https://gitlab.com/acme/infra");
  fireEvent.click(screen.getByRole("button", { name: /^attach repository$/i }));

  await waitFor(() =>
    expect(createMock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ provider: "gitlab" }),
    ),
  );
});
