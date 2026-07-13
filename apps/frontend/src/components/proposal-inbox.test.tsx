import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { Annotation } from "@/api/types";
import { ProposalInbox } from "./proposal-inbox";

const proposal = (
  over: Partial<Annotation> & Pick<Annotation, "id" | "type">,
): Annotation => ({
  repositoryId: "r",
  anchors: ["azurerm_x.web"],
  label: null,
  body: null,
  status: "proposed",
  provenance: "ai",
  reason: null,
  createdFromSha: "sha1",
  parentGroupId: null,
  missingAnchors: [],
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const GROUP = proposal({
  id: "g1",
  type: "group",
  label: "Storefront",
  reason: "The web tier and the database it reads.",
  anchors: ["azurerm_x.web", "azurerm_x.db"],
});

const HIDE = proposal({ id: "h1", type: "hide", anchors: ["azurerm_x.suffix"] });

function setup(overrides: Partial<React.ComponentProps<typeof ProposalInbox>> = {}) {
  const props = {
    proposals: [GROUP, HIDE],
    suggesting: false,
    error: null,
    emptyRun: false,
    onSuggest: vi.fn(),
    onAccept: vi.fn(),
    onEdit: vi.fn(),
    onDismiss: vi.fn(),
    onPreview: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<ProposalInbox {...props} />);
  return props;
}

it("shows each proposal with its reason and an AI badge", () => {
  setup();
  expect(screen.getByText("Storefront")).toBeInTheDocument();
  // Why it was suggested — without it, review is rubber-stamping.
  expect(screen.getByText(/the web tier and the database it reads/i)).toBeInTheDocument();
  expect(screen.getAllByText("AI").length).toBeGreaterThan(0);
  expect(screen.getByText("azurerm_x.db")).toBeInTheDocument();
});

it("groups the proposals by type, with counts", () => {
  setup();
  expect(screen.getByText("Groups (1)")).toBeInTheDocument();
  expect(screen.getByText("Hidden (1)")).toBeInTheDocument();
});

it("accepting a proposal is one explicit act", () => {
  const { onAccept } = setup();
  fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
  expect(onAccept).toHaveBeenCalledWith("g1");
});

it("editing the label and saving accepts it in the same move", () => {
  // You fixed the name *because* you are keeping it — that is one decision.
  const { onEdit } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Edit label"), {
    target: { value: "Order storefront" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save & accept" }));
  expect(onEdit).toHaveBeenCalledWith("g1", "Order storefront");
});

it("dismissing deletes it", () => {
  const { onDismiss } = setup();
  fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
  expect(onDismiss).toHaveBeenCalledWith("g1");
});

it("hovering a proposal asks for its anchors to be lit, and leaving clears them", () => {
  const { onPreview } = setup();
  const row = screen.getByText("Storefront").closest("li")!;
  fireEvent.mouseEnter(row);
  expect(onPreview).toHaveBeenCalledWith(["azurerm_x.web", "azurerm_x.db"]);
  fireEvent.mouseLeave(row);
  expect(onPreview).toHaveBeenLastCalledWith(null);
});

it("offers a bulk accept only when there is more than one group to skim", () => {
  setup({ proposals: [GROUP, HIDE] });
  expect(
    screen.queryByRole("button", { name: /accept all groups/i }),
  ).not.toBeInTheDocument();
});

it("accepts every group at once when asked", () => {
  const second = proposal({ id: "g2", type: "group", label: "Data" });
  const { onAccept } = setup({ proposals: [GROUP, second, HIDE] });
  fireEvent.click(screen.getByRole("button", { name: /accept all groups/i }));
  expect(onAccept).toHaveBeenCalledTimes(2);
  expect(onAccept).toHaveBeenCalledWith("g1");
  expect(onAccept).toHaveBeenCalledWith("g2");
});

it("says so when the model had nothing new to add, rather than looking broken", () => {
  setup({ proposals: [], emptyRun: true });
  expect(screen.getByText(/nothing new to suggest/i)).toBeInTheDocument();
});

it("surfaces a provider failure instead of failing silently", () => {
  setup({ proposals: [], error: "invalid x-api-key" });
  expect(screen.getByRole("alert")).toHaveTextContent("invalid x-api-key");
});
