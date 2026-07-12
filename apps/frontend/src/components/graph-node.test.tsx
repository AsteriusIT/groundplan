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
