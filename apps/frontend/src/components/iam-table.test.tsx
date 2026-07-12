import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, describe } from "vitest";

import type { Graph, GraphNode } from "@/api/types";
import { IamTable } from "./iam-table";

function assignment(
  name: string,
  role: string,
  principal: string,
  scope: string,
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id: `azurerm_role_assignment.${name}`,
    name,
    type: "azurerm_role_assignment",
    provider: "azurerm",
    module_path: [],
    change: null,
    role_assignment: { role, principal, scope },
    privileged: false,
    ...extra,
  };
}

const graph: Graph = {
  version: 4,
  nodes: [
    assignment("owner", "Owner", "sp-11111111", "azurerm_resource_group.main", {
      change: "create",
      privileged: true,
    }),
    assignment(
      "pull",
      "AcrPull",
      "azurerm_user_assigned_identity.aks",
      "azurerm_container_registry.main",
    ),
    // A non-IAM node must never appear as a row.
    {
      id: "azurerm_container_registry.main",
      name: "main",
      type: "azurerm_container_registry",
      provider: "azurerm",
      module_path: [],
      change: null,
    },
  ],
  edges: [],
};

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole("table");
  const [, ...rows] = within(table).getAllByRole("row"); // drop the header row
  return rows;
}

describe("IamTable (GP-48)", () => {
  it("renders one row per role assignment with principal, role and scope", () => {
    render(<IamTable graph={graph} variant="plan" />);
    const rows = bodyRows();
    expect(rows).toHaveLength(2); // registry node excluded
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("AcrPull")).toBeInTheDocument();
    expect(screen.getByText("azurerm_resource_group.main")).toBeInTheDocument();
    expect(screen.getByText("sp-11111111")).toBeInTheDocument();
  });

  it("flags privileged rows with a badge and leaves others unmarked", () => {
    render(<IamTable graph={graph} variant="plan" />);
    const rows = bodyRows();
    const ownerRow = rows.find((r) => within(r).queryByText("Owner"))!;
    const pullRow = rows.find((r) => within(r).queryByText("AcrPull"))!;
    expect(within(ownerRow).getByText(/privileged/i)).toBeInTheDocument();
    expect(within(pullRow).queryByText(/privileged/i)).toBeNull();
  });

  it("shows a change column in plan context and hides it in docs context", () => {
    const { unmount } = render(<IamTable graph={graph} variant="plan" />);
    expect(screen.getByRole("columnheader", { name: /change/i })).toBeInTheDocument();
    expect(screen.getByText("Create")).toBeInTheDocument();
    unmount();

    render(<IamTable graph={graph} variant="docs" />);
    expect(screen.queryByRole("columnheader", { name: /change/i })).toBeNull();
    expect(screen.queryByText("Create")).toBeNull();
  });

  it("filters rows with the search box", () => {
    render(<IamTable graph={graph} variant="plan" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "acrpull" } });
    const rows = bodyRows();
    expect(rows).toHaveLength(1);
    expect(screen.getByText("AcrPull")).toBeInTheDocument();
    expect(screen.queryByText("Owner")).toBeNull();
  });

  it("filters to privileged rows only when toggled", () => {
    render(<IamTable graph={graph} variant="plan" />);
    fireEvent.click(screen.getByRole("button", { name: /privileged only/i }));
    const rows = bodyRows();
    expect(rows).toHaveLength(1);
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("sorts by a column when its header is clicked", () => {
    render(<IamTable graph={graph} variant="plan" />);
    // Default order is by role ascending: AcrPull, Owner.
    expect(bodyRows().map((r) => within(r).getByText(/Owner|AcrPull/).textContent)).toEqual([
      "AcrPull",
      "Owner",
    ]);
    // Toggling the Role header reverses it.
    fireEvent.click(screen.getByRole("button", { name: /role/i }));
    expect(bodyRows().map((r) => within(r).getByText(/Owner|AcrPull/).textContent)).toEqual([
      "Owner",
      "AcrPull",
    ]);
  });

  it("shows an empty state when there are no IAM resources", () => {
    render(
      <IamTable graph={{ version: 4, nodes: [], edges: [] }} variant="plan" />,
    );
    expect(screen.getByText(/no iam resources/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
