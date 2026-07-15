import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, listEvents: vi.fn(), listSnapshots: vi.fn() };
});

import { listEvents, listSnapshots } from "@/api/client";
import type { IngestionEvent, SnapshotSummary } from "@/api/types";
import { IngestionStatus } from "./ingestion-status";

const listEventsMock = vi.mocked(listEvents);
const listSnapshotsMock = vi.mocked(listSnapshots);

const event: IngestionEvent = {
  id: "e1",
  ref: "refs/heads/feature-x",
  commitSha: "abcdef1234567",
  event: "pull_request",
  parseError: null,
  receivedAt: "2026-07-10T00:00:00.000Z",
};

const docsSnapshot: SnapshotSummary = {
  id: "s1",
  repositoryId: "r1",
  clusterId: null,
  namespace: null,
  source: "hcl",
  ref: "main",
  commitSha: "deadbeef",
  prNumber: null,
  stats: {
    nodes: 3,
    edges: 1,
    changes: { create: 0, update: 0, delete: 0, noop: 0, unchanged: 3 },
  },
  createdAt: "2026-07-11T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

it("shows the empty state when no plan has been received", async () => {
  listEventsMock.mockResolvedValue([]);
  listSnapshotsMock.mockResolvedValue([]);

  render(<IngestionStatus repositoryId="r1" iacType="terraform" />);

  expect(await screen.findByText(/No plan received yet/i)).toBeInTheDocument();
});

it("shows the last plan's branch, sha and date, plus the last docs snapshot", async () => {
  listEventsMock.mockResolvedValue([event]);
  listSnapshotsMock.mockResolvedValue([docsSnapshot]);

  render(<IngestionStatus repositoryId="r1" iacType="terraform" />);

  // Branch (short name), short sha, and the received date.
  expect(await screen.findByText("feature-x")).toBeInTheDocument();
  expect(screen.getByText("abcdef12")).toBeInTheDocument();
  expect(screen.getByText(/10 Jul 2026/)).toBeInTheDocument();
  // The last docs snapshot's date.
  expect(screen.getByText(/11 Jul 2026/)).toBeInTheDocument();
});

it("reads the manifest source for a Kubernetes repository", async () => {
  listEventsMock.mockResolvedValue([]);
  listSnapshotsMock.mockResolvedValue([]);

  render(<IngestionStatus repositoryId="r1" iacType="kubernetes" />);
  await screen.findByText(/No plan received yet/i);

  expect(listSnapshotsMock).toHaveBeenCalledWith("r1", { source: "k8s_manifest" });
});

it("has no accessibility violations", async () => {
  listEventsMock.mockResolvedValue([event]);
  listSnapshotsMock.mockResolvedValue([docsSnapshot]);

  const { baseElement } = render(
    <main>
      <IngestionStatus repositoryId="r1" iacType="terraform" />
    </main>,
  );
  await screen.findByText("feature-x");
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
