import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

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
