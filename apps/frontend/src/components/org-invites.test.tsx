import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    listInvitations: vi.fn(),
    createInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
  };
});

import { createInvitation, listInvitations, revokeInvitation } from "@/api/client";
import { OrgInvites } from "./org-invites";

const listInvitationsMock = vi.mocked(listInvitations);
const createInvitationMock = vi.mocked(createInvitation);
const revokeInvitationMock = vi.mocked(revokeInvitation);

beforeEach(() => {
  listInvitationsMock.mockReset();
  createInvitationMock.mockReset();
  revokeInvitationMock.mockReset();
  listInvitationsMock.mockResolvedValue([]);
});

it("creates an invite and surfaces its shareable link", async () => {
  createInvitationMock.mockResolvedValue({
    id: "i1",
    organizationId: "o1",
    email: null,
    role: "member",
    expiresAt: "2026-02-01T00:00:00.000Z",
    acceptedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    token: "tok-abc",
    url: "https://app.example.com/invite/tok-abc",
  });
  render(<OrgInvites />);

  fireEvent.click(await screen.findByRole("button", { name: /create invite/i }));

  await waitFor(() =>
    expect(createInvitationMock).toHaveBeenCalledWith({ role: "member", email: undefined }),
  );
  expect(
    await screen.findByText("https://app.example.com/invite/tok-abc"),
  ).toBeInTheDocument();
});

it("lists pending invites and revokes one", async () => {
  listInvitationsMock.mockResolvedValue([
    {
      id: "i9",
      organizationId: "o1",
      email: "carol@example.com",
      role: "admin",
      expiresAt: "2026-02-01T00:00:00.000Z",
      acceptedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  revokeInvitationMock.mockResolvedValue(undefined);
  render(<OrgInvites />);

  expect(await screen.findByText("carol@example.com")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

  await waitFor(() => expect(revokeInvitationMock).toHaveBeenCalledWith("i9"));
  await waitFor(() =>
    expect(screen.queryByText("carol@example.com")).not.toBeInTheDocument(),
  );
});
