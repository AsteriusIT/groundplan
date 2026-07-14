import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    listClusters: vi.fn(),
    createCluster: vi.fn(),
    verifyCluster: vi.fn(),
    deleteCluster: vi.fn(),
  };
});

import { ApiError, createCluster, listClusters } from "@/api/client";
import type { Cluster } from "@/api/types";
import { ClustersPage } from "./clusters-page";

const listClustersMock = vi.mocked(listClusters);
const createClusterMock = vi.mocked(createCluster);

function cluster(over: Partial<Cluster> = {}): Cluster {
  return {
    id: "c1",
    name: "production",
    kubeconfig: "***",
    connectionStatus: "ok",
    verifiedAt: "2026-07-14T10:00:00.000Z",
    createdAt: "2026-07-14T09:00:00.000Z",
    ...over,
  };
}

const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: prod
`;

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/clusters"]}>
      <ClustersPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listClustersMock.mockReset();
  createClusterMock.mockReset();
  listClustersMock.mockResolvedValue([]);
});

it("lists attached clusters with their connection status", async () => {
  listClustersMock.mockResolvedValue([cluster()]);
  renderPage();

  expect(await screen.findByText("production")).toBeInTheDocument();
  // Status is on the row (a dot with an accessible name), never the kubeconfig.
  expect(
    screen.getAllByRole("img", { name: /connected/i }).length,
  ).toBeGreaterThan(0);
  expect(document.body.textContent).not.toContain("***");
});

it("a cluster links to its own namespaces, not through a project", async () => {
  listClustersMock.mockResolvedValue([cluster()]);
  renderPage();

  const link = await screen.findByRole("link", { name: /namespaces/i });
  expect(link).toHaveAttribute("href", "/clusters/c1");
});

it("no clusters yet is one CTA, not an empty table", async () => {
  renderPage();

  expect(await screen.findByText(/no clusters attached/i)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /attach a cluster/i }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("attaching a cluster asks for no project, and adds it to the list", async () => {
  createClusterMock.mockResolvedValue(cluster({ name: "staging" }));
  renderPage();

  fireEvent.click(
    await screen.findByRole("button", { name: /attach a cluster/i }),
  );

  // A cluster belongs to nothing — the form must not ask which project.
  expect(screen.queryByLabelText(/project/i)).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/cluster name/i), {
    target: { value: "staging" },
  });
  fireEvent.change(screen.getByLabelText(/kubeconfig/i), {
    target: { value: KUBECONFIG },
  });
  fireEvent.click(screen.getByRole("button", { name: /^attach cluster$/i }));

  expect(await screen.findByText(/cluster attached/i)).toBeInTheDocument();
  // The API takes the cluster alone — no project id rides along.
  expect(createClusterMock).toHaveBeenCalledWith({
    name: "staging",
    kubeconfig: KUBECONFIG,
  });

  // The kubeconfig went up once and is gone from the page.
  fireEvent.click(screen.getByRole("button", { name: /done/i }));
  expect(await screen.findByText("staging")).toBeInTheDocument();
  await waitFor(() =>
    expect(document.body.textContent).not.toContain("current-context"),
  );
});

it("a failed list is an error you can retry, not a silent empty page", async () => {
  listClustersMock.mockRejectedValue(new ApiError(500, "boom"));
  renderPage();

  expect(await screen.findByRole("alert")).toHaveTextContent(/boom/i);
  expect(
    screen.getByRole("button", { name: /try again/i }),
  ).toBeInTheDocument();
  expect(screen.queryByText(/no clusters attached/i)).not.toBeInTheDocument();
});
