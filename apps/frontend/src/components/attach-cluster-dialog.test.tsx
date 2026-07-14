import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, createCluster: vi.fn(), verifyCluster: vi.fn() };
});

import { ApiError, createCluster, verifyCluster } from "@/api/client";
import type { Cluster } from "@/api/types";
import { AttachClusterDialog } from "./attach-cluster-dialog";

const createMock = vi.mocked(createCluster);
const verifyMock = vi.mocked(verifyCluster);

const KUBECONFIG = "apiVersion: v1\nkind: Config\ncurrent-context: prod\n";

const attached: Cluster = {
  id: "c1",
  name: "prod",
  kubeconfig: "***",
  connectionStatus: "ok",
  verifiedAt: "2026-07-14T10:00:00.000Z",
  createdAt: "2026-07-14T10:00:00.000Z",
};

beforeEach(() => {
  createMock.mockReset().mockResolvedValue(attached);
  verifyMock.mockReset().mockResolvedValue({ ok: true, version: "v1.31.0" });
});

function open(onAttached = vi.fn()) {
  render(
    <AttachClusterDialog
      onAttached={onAttached}
      trigger={<button>Attach cluster</button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Attach cluster" }));
  return { onAttached };
}

function fillIn(kubeconfig = KUBECONFIG) {
  fireEvent.change(screen.getByLabelText(/cluster name/i), {
    target: { value: "prod" },
  });
  fireEvent.change(screen.getByLabelText(/kubeconfig/i), {
    target: { value: kubeconfig },
  });
}

it("attaches a cluster and reports it verified", async () => {
  const { onAttached } = open();
  fillIn();
  fireEvent.click(screen.getByRole("button", { name: /^attach cluster$/i }));

  await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
  // No project rides along — a cluster belongs to nobody.
  expect(createMock).toHaveBeenCalledWith({ name: "prod", kubeconfig: KUBECONFIG });
  expect(await screen.findByText(/connected/i)).toBeInTheDocument();

  // It joins the list when the dialog closes, not while it is still open — the
  // list rerendering under a dialog can unmount the dialog mid-flow (GP-16).
  fireEvent.click(screen.getByRole("button", { name: /done/i }));
  await waitFor(() => expect(onAttached).toHaveBeenCalledWith(attached));
});

it("never puts the kubeconfig back in the DOM once it is submitted", async () => {
  open();
  fillIn();
  fireEvent.click(screen.getByRole("button", { name: /^attach cluster$/i }));

  await waitFor(() => expect(createMock).toHaveBeenCalled());
  // The form is gone, and with it the only field that ever held the credential.
  await waitFor(() =>
    expect(screen.queryByLabelText(/kubeconfig/i)).not.toBeInTheDocument(),
  );
  expect(document.body.textContent).not.toContain("current-context");
});

it("says what the credential is used for, in the form", () => {
  open();
  // Trust copy is not decoration: it is the answer to "what will you do with this".
  expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  expect(screen.getByText(/never read Secret values/i)).toBeInTheDocument();
  expect(screen.getByText(/current context/i)).toBeInTheDocument();
});

it("shows the reason a failed connection failed", async () => {
  createMock.mockResolvedValue({ ...attached, connectionStatus: "failed" });
  verifyMock.mockResolvedValue({ ok: false, error: "auth_failed" });
  open();
  fillIn();
  fireEvent.click(screen.getByRole("button", { name: /^attach cluster$/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    /rejected the credentials/i,
  );
});

it("surfaces a rejected kubeconfig without losing what was typed", async () => {
  createMock.mockRejectedValue(
    new ApiError(422, "kubeconfig has no current-context"),
  );
  open();
  fillIn("garbage");
  fireEvent.click(screen.getByRole("button", { name: /^attach cluster$/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/current-context/i);
  // Still on the form, still holding the paste: a 422 is a fix, not a restart.
  expect(screen.getByLabelText(/kubeconfig/i)).toHaveValue("garbage");
});

it("has no accessibility violations", async () => {
  const { baseElement } = render(
    <AttachClusterDialog
      onAttached={vi.fn()}
      trigger={<button>Attach cluster</button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Attach cluster" }));
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
