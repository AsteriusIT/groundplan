import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import type { GraphNode } from "@/api/types";
import { NodeCard } from "./graph-node";

const rg: GraphNode = {
  id: "rg",
  name: "rg",
  type: "azurerm_resource_group",
  provider: "azurerm",
  module_path: [],
  change: null,
};

const child = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  name: id,
  type: "azurerm_lb_probe",
  provider: "azurerm",
  module_path: [],
  change: null,
  ...over,
});

const lb: GraphNode = { ...rg, id: "lb", name: "lb", type: "azurerm_lb" };

it("shows the hidden-connection counter chip on a hub node (GP-35)", () => {
  render(<NodeCard graphNode={rg} isHub hubHiddenCount={80} />);
  expect(screen.getByText("80")).toBeInTheDocument();
  expect(document.querySelector('[title*="hidden connection"]')).toBeTruthy();
});

it("shows a bare hub indicator when connections are revealed", () => {
  render(<NodeCard graphNode={rg} isHub hubHiddenCount={0} />);
  expect(screen.queryByText("0")).not.toBeInTheDocument();
  expect(document.querySelector('[title*="connections shown"]')).toBeTruthy();
});

it("renders no hub chip for a non-hub node", () => {
  render(<NodeCard graphNode={{ ...rg, type: "aws_instance" }} />);
  expect(document.querySelector('[title*="connection"]')).toBeFalsy();
});

it("shows the exposure badge on an internet-exposed node (GP-45)", () => {
  render(
    <NodeCard
      graphNode={{ ...rg, type: "azurerm_network_security_group" }}
      exposed
    />,
  );
  expect(screen.getByLabelText(/internet-exposed/i)).toBeInTheDocument();
});

it("shows no exposure badge when the node is not exposed", () => {
  render(<NodeCard graphNode={{ ...rg, type: "azurerm_network_security_group" }} />);
  expect(screen.queryByLabelText(/internet-exposed/i)).not.toBeInTheDocument();
});

it("marks a picked node (annotate selection) with a check badge + tint (GP-58)", () => {
  const { container } = render(<NodeCard graphNode={rg} picked />);
  expect(screen.getByText("✓")).toBeInTheDocument();
  expect(container.querySelector(".bg-primary\\/10")).toBeTruthy();
});

it("shows no pick badge on an unpicked node", () => {
  render(<NodeCard graphNode={rg} />);
  expect(screen.queryByText("✓")).not.toBeInTheDocument();
});

// --- Annotation treatment (GP-73) -------------------------------------------

it("marks a node carrying a hide, rather than letting it look untouched", () => {
  // The raw view still draws it — that is what the code says — but an
  // instruction you cannot see is one you will give twice.
  render(<NodeCard graphNode={rg} hiddenByAnnotation />);
  expect(screen.getByTitle("Hidden in the adapted view")).toBeInTheDocument();
});

it("shows a rename's label, keeping the derived name reachable", () => {
  render(<NodeCard graphNode={rg} renameLabel="Shared platform" />);
  expect(screen.getByText("Shared platform")).toBeInTheDocument();
  // A rename is a lens, not an erasure: the truth is still on the node.
  expect(screen.getByTitle("rg")).toBeInTheDocument();
});

it("prefers the projection's display_label over a locally-known rename", () => {
  render(
    <NodeCard
      graphNode={{ ...rg, display_label: "From the projection" }}
      renameLabel="From the client"
    />,
  );
  expect(screen.getByText("From the projection")).toBeInTheDocument();
});

// --- Stacked host card (GP-87) ----------------------------------------------

it("renders each stacked satellite child as a row with its name and status", () => {
  render(
    <NodeCard
      graphNode={lb}
      stack={[
        child("web-probe", { change: "update" }),
        child("web-pool", { type: "azurerm_lb_backend_address_pool" }),
      ]}
    />,
  );
  expect(screen.getByText("web-probe")).toBeInTheDocument();
  expect(screen.getByText("web-pool")).toBeInTheDocument();
  // The changed child shows its status on the row.
  expect(screen.getByLabelText("Update")).toBeInTheDocument();
});

it("selects the child when its row is clicked", () => {
  const onSelect = vi.fn();
  const probe = child("web-probe");
  render(<NodeCard graphNode={lb} stack={[probe]} onSelectStackChild={onSelect} />);
  fireEvent.click(screen.getByText("web-probe"));
  expect(onSelect).toHaveBeenCalledWith(probe);
});

it("collapses past six children behind a +n more that expands in place", () => {
  const many = Array.from({ length: 9 }, (_, i) => child(`c${i}`));
  render(<NodeCard graphNode={lb} stack={many} />);
  expect(screen.getByText("+3 more")).toBeInTheDocument();
  expect(screen.queryByText("c8")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("+3 more"));
  expect(screen.getByText("c8")).toBeInTheDocument();
});

it("shows no +n more row at six children or fewer", () => {
  const six = Array.from({ length: 6 }, (_, i) => child(`c${i}`));
  render(<NodeCard graphNode={lb} stack={six} />);
  expect(screen.queryByText(/more/)).not.toBeInTheDocument();
});

it("wears the impacted ring when a stacked child changed", () => {
  const { container } = render(
    <NodeCard graphNode={lb} stack={[child("probe", { change: "update" })]} stackChanged />,
  );
  expect(container.querySelector(".outline-impacted")).toBeTruthy();
});

it("renders no stack section for a node with no children", () => {
  const { container } = render(<NodeCard graphNode={rg} />);
  expect(container.querySelector('[data-stack-row]')).toBeFalsy();
});

it("a stacked host card is accessible (keyboard-reachable rows, GP-87)", async () => {
  const { baseElement } = render(
    <main>
      <NodeCard
        graphNode={lb}
        stack={[child("probe", { change: "update" }), child("pool")]}
      />
    </main>,
  );
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});

it("renders attachment chips on the card and selects on click", () => {
  const onSelectChip = vi.fn();
  const avset = child("avset", { type: "azurerm_availability_set", name: "app" });
  render(
    <NodeCard
      graphNode={{ ...rg, id: "vm", type: "azurerm_linux_virtual_machine" }}
      chips={[avset]}
      onSelectChip={onSelectChip}
    />,
  );
  const chip = screen.getByTitle("azurerm_availability_set · app");
  fireEvent.click(chip);
  expect(onSelectChip).toHaveBeenCalledWith(avset);
});

it("renders no chip row without chips", () => {
  render(<NodeCard graphNode={rg} />);
  expect(document.querySelector("[data-subnet-chip]")).toBeFalsy();
});

it("prefixes a stacked row with its kind", () => {
  render(
    <NodeCard
      graphNode={lb}
      stack={[
        child("p", { name: "app", type: "azurerm_lb_backend_address_pool" }),
        child("pr", { name: "app", type: "azurerm_lb_probe" }),
      ]}
    />,
  );
  expect(screen.getByText("pool")).toBeInTheDocument();
  expect(screen.getByText("probe")).toBeInTheDocument();
});

it("shows a ×n badge for a literal count", () => {
  render(
    <NodeCard
      graphNode={{
        ...rg,
        id: "vm",
        type: "azurerm_linux_virtual_machine",
        attributes: { count: "2" },
      }}
    />,
  );
  expect(screen.getByText("×2")).toBeInTheDocument();
});

it("shows no count badge without the attribute", () => {
  render(<NodeCard graphNode={rg} />);
  expect(screen.queryByText(/^×/)).not.toBeInTheDocument();
});
