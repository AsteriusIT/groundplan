import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { GraphNode } from "@/api/types";
import { NetworkContainer } from "./network-container-node";

const subnet: GraphNode = {
  id: "sn",
  name: "internal",
  type: "azurerm_subnet",
  provider: "azurerm",
  module_path: [],
  change: null,
};

it("labels the container with its resource identity", () => {
  render(<NetworkContainer graphNode={subnet} />);
  expect(screen.getByText("internal")).toBeInTheDocument(); // name
  expect(screen.getByText("subnet")).toBeInTheDocument(); // shortType
});
