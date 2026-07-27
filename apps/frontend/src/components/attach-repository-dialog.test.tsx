import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    createRepository: vi.fn(),
    verifyRepository: vi.fn(),
    listConnections: vi.fn(),
  };
});

import {
  ApiError,
  createRepository,
  listConnections,
  verifyRepository,
} from "@/api/client";
import type { CreatedRepository, ProviderConnection } from "@/api/types";
import { AttachRepositoryDialog } from "./attach-repository-dialog";

const createMock = vi.mocked(createRepository);
const verifyMock = vi.mocked(verifyRepository);
const connectionsMock = vi.mocked(listConnections);

/** An org-level GitHub App installation on one account (GP-193). */
function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: "c1",
    organizationId: "o1",
    provider: "github",
    mode: "installation_app",
    name: "acme",
    config: { installationId: 42, account: "acme" },
    status: "ok",
    lastError: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const created: CreatedRepository = {
  id: "r1",
  projectId: "p1",
  provider: "gitlab",
  iacType: "terraform",
  url: "https://gitlab.com/acme/infra",
  defaultBranch: "main",
  accessToken: null,
  credentialId: null,
  authMode: null,
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
  // No connection by default: the token path, exactly as before (GP-51/52).
  connectionsMock.mockReset().mockResolvedValue([]);
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

// --- GP-104: what's in this repository? ---

it("attaches a Terraform repository unless told otherwise", async () => {
  open();

  await typeUrl("https://github.com/acme/infra");
  expect(screen.getByRole("button", { name: "Terraform" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByLabelText("Terraform path")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^attach repository$/i }));
  await waitFor(() =>
    expect(createMock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ iacType: "terraform" }),
    ),
  );
});

it("a Kubernetes repository renames the path field, because it is not Terraform's", async () => {
  open();

  await typeUrl("https://github.com/acme/manifests");
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));

  // Same field, same validation — a different thing to say about it.
  expect(screen.queryByLabelText("Terraform path")).not.toBeInTheDocument();
  const path = screen.getByLabelText("Manifests path");
  fireEvent.change(path, { target: { value: "deploy/prod" } });

  fireEvent.click(screen.getByRole("button", { name: /^attach repository$/i }));
  await waitFor(() =>
    expect(createMock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ iacType: "kubernetes", terraformPath: "deploy/prod" }),
    ),
  );
});

it("a Kubernetes repository is set up with manifest snippets, not plan ones", async () => {
  createMock.mockResolvedValue({ ...created, iacType: "kubernetes" });
  open();

  await typeUrl("https://github.com/acme/manifests");
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  fireEvent.click(screen.getByRole("button", { name: /^attach repository$/i }));

  // The success step asks the only question that changes the workflow: how does
  // this repository's YAML get made?
  expect(await screen.findByRole("group", { name: "Manifest flavour" })).toBeInTheDocument();

  const workflow = () => document.querySelector("pre")?.textContent ?? "";
  expect(workflow()).toContain("payload:{manifests:$manifests}");
  expect(workflow()).not.toContain("terraform plan");

  fireEvent.click(screen.getByRole("button", { name: "Helm" }));
  expect(workflow()).toContain("helm template . -f values.yaml");
});

// --- GP-231: the credential is reported, not demanded ------------------------

it("asks for no token when an installation already covers the owner", async () => {
  connectionsMock.mockResolvedValue([connection()]);
  open();

  // Before a readable URL there is nothing to say, so the token path stands.
  expect(await screen.findByLabelText("Access token")).toBeInTheDocument();

  await typeUrl("https://github.com/acme/infra");
  await waitFor(() =>
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument(),
  );
  expect(screen.getByText(/Access via acme/i)).toBeInTheDocument();
  expect(screen.getByText(/No token needed/i)).toBeInTheDocument();
});

it("keeps the token path for an owner no installation covers", async () => {
  connectionsMock.mockResolvedValue([connection()]);
  open();

  await typeUrl("https://github.com/elsewhere/infra");
  expect(await screen.findByLabelText("Access token")).toBeInTheDocument();
  expect(screen.queryByText(/Access via/i)).not.toBeInTheDocument();
});

it("matches the owner case-insensitively, as the provider does", async () => {
  connectionsMock.mockResolvedValue([connection({ config: { account: "ACME" } })]);
  open();

  await typeUrl("https://github.com/acme/infra");
  await waitFor(() =>
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument(),
  );
});

it("does not use a connection belonging to another provider", async () => {
  connectionsMock.mockResolvedValue([
    connection({ provider: "gitlab", config: { account: "acme" } }),
  ]);
  open();

  await typeUrl("https://github.com/acme/infra");
  expect(await screen.findByLabelText("Access token")).toBeInTheDocument();
});

it("asks which connection when several cover the owner, and never guesses", async () => {
  connectionsMock.mockResolvedValue([
    connection({ id: "c1", name: "acme-eu" }),
    connection({ id: "c2", name: "acme-us" }),
  ]);
  open();

  await typeUrl("https://github.com/acme/infra");
  const picker = await screen.findByLabelText("Connection");
  expect(picker).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "acme-eu" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "acme-us" })).toBeInTheDocument();

  fireEvent.change(picker, { target: { value: "c2" } });
  fireEvent.click(screen.getByRole("button", { name: /^attach repository$/i }));
  await waitFor(() =>
    expect(createMock).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ credentialId: "c2" }),
    ),
  );
});

it("sends the covering connection, and no token, when one covers the repo", async () => {
  connectionsMock.mockResolvedValue([connection({ id: "c9" })]);
  open();

  await typeUrl("https://github.com/acme/infra");
  await waitFor(() =>
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: /^attach repository$/i }));

  await waitFor(() => expect(createMock).toHaveBeenCalled());
  const [, input] = createMock.mock.calls[0]!;
  expect(input.credentialId).toBe("c9");
  expect(input.accessToken).toBeUndefined();
});

it("shows a typed refusal in the modal, with what to do about it", async () => {
  createMock.mockRejectedValue(
    new ApiError(
      422,
      "the acme installation does not cover this repository",
      undefined,
      "installation_does_not_cover_repo",
    ),
  );
  open();

  await typeUrl("https://github.com/acme/infra");
  fireEvent.click(screen.getByRole("button", { name: /^attach repository$/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/does not cover/i);
  expect(screen.getByText(/Add this repository to the app/i)).toBeInTheDocument();
  // The form is still open on the URL that needs fixing.
  expect(screen.getByLabelText("Repository URL")).toBeInTheDocument();
});

it("warns that the type is permanent before the repository is attached", async () => {
  open();
  expect(await screen.findByText(/cannot be changed later/i)).toBeInTheDocument();
  expect(screen.getByText(/attached twice, with a different path/i)).toBeInTheDocument();
});

it("never asks which Groundplan organization — that comes from the route", async () => {
  open();
  await typeUrl("https://github.com/acme/infra");
  expect(screen.queryByLabelText(/organization/i)).not.toBeInTheDocument();
});

it("an instance connection covers its instance, not just its own namespace", async () => {
  // A GitLab OAuth connection is a *user's* authorization: `tintin92350` may
  // read `helix-saas/infra` perfectly well. Matching the account against the
  // namespace demanded a token for every group project.
  connectionsMock.mockResolvedValue([
    connection({
      provider: "gitlab",
      mode: "oauth2",
      name: "GitLab · tintin92350",
      config: { account: "tintin92350", instanceUrl: "https://gitlab.com" },
    }),
  ]);
  open();

  await typeUrl("https://gitlab.com/helix-saas/infra-terraform.git");
  await waitFor(() =>
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument(),
  );
  expect(screen.getByText(/Access via GitLab · tintin92350/i)).toBeInTheDocument();
});

it("an instance connection does not cover a different instance", async () => {
  connectionsMock.mockResolvedValue([
    connection({
      provider: "gitlab",
      mode: "oauth2",
      config: { account: "someone", instanceUrl: "https://git.acme.internal" },
    }),
  ]);
  open();

  await typeUrl("https://gitlab.com/helix-saas/infra.git");
  expect(await screen.findByLabelText("Access token")).toBeInTheDocument();
});
