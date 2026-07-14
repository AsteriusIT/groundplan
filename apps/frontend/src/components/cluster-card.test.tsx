import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, verifyCluster: vi.fn(), deleteCluster: vi.fn() };
});

import { deleteCluster, verifyCluster } from "@/api/client";
import type { Cluster } from "@/api/types";
import { ClusterCard } from "./cluster-card";

const verifyMock = vi.mocked(verifyCluster);
const deleteMock = vi.mocked(deleteCluster);

const cluster: Cluster = {
  id: "c1",
  projectId: "p1",
  name: "production",
  kubeconfig: "***",
  connectionStatus: "ok",
  verifiedAt: "2026-07-14T10:00:00.000Z",
  createdAt: "2026-07-14T09:00:00.000Z",
};

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue({ ok: true, version: "v1.31.0" });
  deleteMock.mockReset().mockResolvedValue(undefined);
});

function renderCard(overrides: Partial<Cluster> = {}) {
  const onChanged = vi.fn();
  const onDeleted = vi.fn();
  const utils = render(
    <MemoryRouter>
      {/* The card lives inside the layout's main region in the app; axe wants to
          see it in one here too, rather than floating in a bare document. */}
      <main>
        <ClusterCard
          cluster={{ ...cluster, ...overrides }}
          onChanged={onChanged}
          onDeleted={onDeleted}
        />
      </main>
    </MemoryRouter>,
  );
  return { ...utils, onChanged, onDeleted };
}

/** Radix opens a menu on keyboard activation; jsdom has no real pointer. */
function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: /manage production/i }), {
    key: "Enter",
  });
}

it("re-verifying updates the status without a reload", async () => {
  const { onChanged } = renderCard({ connectionStatus: "failed" });

  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /verify connection/i }));

  await waitFor(() => expect(verifyMock).toHaveBeenCalledWith("c1"));
  await waitFor(() =>
    expect(onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1", connectionStatus: "ok" }),
    ),
  );
});

it("a failed re-verify says why", async () => {
  verifyMock.mockResolvedValue({ ok: false, error: "auth_failed" });
  renderCard();

  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /verify connection/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/rejected the credentials/i);
});

it("removing a cluster asks first", async () => {
  const { onDeleted } = renderCard();

  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /remove cluster/i }));

  // Nothing has happened yet — the confirm is the decision point.
  expect(deleteMock).not.toHaveBeenCalled();
  expect(await screen.findByRole("dialog")).toHaveTextContent(/remove cluster/i);

  fireEvent.click(screen.getByRole("button", { name: /^remove cluster$/i }));
  await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("c1"));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("c1"));
});

it("never renders the kubeconfig, masked or otherwise", () => {
  renderCard();
  expect(document.body.textContent).not.toContain("***");
});

it("has no accessibility violations", async () => {
  const { baseElement } = renderCard();
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
