import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    listMembers: vi.fn(),
    changeMemberRole: vi.fn(),
    removeMember: vi.fn(),
  };
});
vi.mock("@/auth/use-auth", () => ({ useAuth: () => ({ user: { id: "me" } }) }));

import { changeMemberRole, listMembers, removeMember } from "@/api/client";
import type { Member, Role } from "@/api/types";
import { OrgContext, type OrgContextValue } from "@/org/org-context";
import { OrgMembers } from "./org-members";

const listMembersMock = vi.mocked(listMembers);
const changeMemberRoleMock = vi.mocked(changeMemberRole);
const removeMemberMock = vi.mocked(removeMember);

function member(over: Partial<Member> = {}): Member {
  return {
    userId: "u2",
    email: "bob@example.com",
    displayName: "Bob",
    role: "member",
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function renderAs(role: Role) {
  const value: OrgContextValue = {
    memberships: [],
    activeOrg: { id: "o1", name: "Org", slug: "org", role },
    singleOrg: false,
    switchOrg: vi.fn(),
  };
  return render(
    <OrgContext.Provider value={value}>
      <OrgMembers />
    </OrgContext.Provider>,
  );
}

beforeEach(() => {
  listMembersMock.mockReset();
  changeMemberRoleMock.mockReset();
  removeMemberMock.mockReset();
});

it("an owner can change a member's role and remove them", async () => {
  listMembersMock.mockResolvedValue([
    member(),
    member({ userId: "me", email: "me@example.com", role: "owner" }),
  ]);
  changeMemberRoleMock.mockResolvedValue(member({ role: "admin" }));
  removeMemberMock.mockResolvedValue(undefined);
  renderAs("owner");

  const select = await screen.findByLabelText("Role for bob@example.com");
  fireEvent.change(select, { target: { value: "admin" } });
  await waitFor(() =>
    expect(changeMemberRoleMock).toHaveBeenCalledWith("u2", "admin"),
  );

  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
  await waitFor(() => expect(removeMemberMock).toHaveBeenCalledWith("u2"));
});

it("a member sees roles read-only (no controls)", async () => {
  listMembersMock.mockResolvedValue([member()]);
  renderAs("member");

  expect(await screen.findByText("Bob")).toBeInTheDocument();
  expect(screen.queryByLabelText(/^Role for/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
});

it("disables changing or removing the last owner", async () => {
  listMembersMock.mockResolvedValue([
    member({ userId: "me", email: "me@example.com", role: "owner" }),
  ]);
  renderAs("owner");

  const select = await screen.findByLabelText("Role for me@example.com");
  expect(select).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
});
