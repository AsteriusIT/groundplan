import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    listShareLinks: vi.fn(),
    createShareLink: vi.fn(),
    revokeShareLink: vi.fn(),
  };
});

import { createShareLink, listShareLinks, revokeShareLink } from "@/api/client";
import type { ShareLink } from "@/api/types";
import { ShareDialog } from "./share-dialog";

const listMock = vi.mocked(listShareLinks);
const createMock = vi.mocked(createShareLink);
const revokeMock = vi.mocked(revokeShareLink);

const link: ShareLink = {
  id: "l1",
  token: "tok123456789012",
  kind: "docs_latest",
  snapshotId: null,
  createdAt: "2026-07-11T00:00:00.000Z",
};

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([]);
  createMock.mockReset().mockResolvedValue(link);
  revokeMock.mockReset().mockResolvedValue(undefined);
});

function open() {
  render(<ShareDialog repositoryId="r1" currentSnapshotId="s1" />);
  fireEvent.click(screen.getByRole("button", { name: /share/i }));
}

it("creates an always-latest link and lists it", async () => {
  listMock.mockResolvedValueOnce([]).mockResolvedValue([link]);
  open();

  expect(await screen.findByText(/No active share links yet/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /always latest/i }));

  await waitFor(() =>
    expect(createMock).toHaveBeenCalledWith("r1", { kind: "docs_latest", snapshotId: undefined }),
  );
  // The freshly created link's URL shows up (built from its token).
  expect(await screen.findByText(/\/share\/tok123456789012/)).toBeInTheDocument();
});

it("pins the current snapshot when asked", async () => {
  open();
  await screen.findByText(/No active share links yet/);
  fireEvent.click(screen.getByRole("button", { name: /pin this version/i }));
  await waitFor(() =>
    expect(createMock).toHaveBeenCalledWith("r1", { kind: "snapshot", snapshotId: "s1" }),
  );
});

it("revokes a link", async () => {
  listMock.mockResolvedValue([link]);
  open();

  const revokeBtn = await screen.findByRole("button", { name: /revoke link/i });
  fireEvent.click(revokeBtn);
  await waitFor(() => expect(revokeMock).toHaveBeenCalledWith("l1"));
});
