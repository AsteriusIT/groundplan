import { expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { BuildMode } from "./build-mode";
import { useBuilderGraph } from "./use-builder-graph";

/** The real controller, wired to the real mode — this is the feature. */
function Harness() {
  const builder = useBuilderGraph();
  return <BuildMode builder={builder} />;
}

/** Add a resource from the palette by its label. */
function addFromPalette(label: string) {
  const palette = screen.getByLabelText("Resource palette");
  fireEvent.click(within(palette).getByRole("button", { name: new RegExp(label, "i") }));
}

/** The open form's field, by its visible label. */
function field(label: string | RegExp): HTMLElement {
  const panel = screen.getByLabelText("Resource details");
  return within(panel).getByLabelText(label);
}

it("composes a resource from the palette and opens its form", () => {
  render(<Harness />);
  expect(screen.getByRole("status")).toHaveTextContent("Nothing composed yet");

  addFromPalette("Resource group");

  // The node is on the canvas, and the form for it opened on the right.
  expect(screen.getByTestId("builder-node-n1")).toBeInTheDocument();
  const panel = screen.getByLabelText("Resource details");
  expect(within(panel).getByLabelText(/Terraform name/)).toHaveValue(
    "resource_group",
  );
  // The catalog default is what the form shows, and what will be generated.
  expect(within(panel).getByLabelText(/Location/)).toHaveValue("westeurope");
});

it("flags a required attribute nobody filled in, on the node and in the form", () => {
  render(<Harness />);
  addFromPalette("Resource group");

  expect(screen.getByRole("status")).toHaveTextContent("1 problem to fix");
  expect(
    screen.getByLabelText("resource_group has 1 problem"),
  ).toBeInTheDocument();
  expect(screen.getByText("Azure name is required")).toBeInTheDocument();

  fireEvent.change(field(/Azure name/), { target: { value: "rg-demo" } });

  expect(screen.getByRole("status")).toHaveTextContent("1 resource · ready to generate");
});

it("only offers connections the catalog allows, and records the one made", () => {
  render(<Harness />);
  addFromPalette("Resource group");
  fireEvent.change(field(/Azure name/), { target: { value: "rg-demo" } });

  addFromPalette("Virtual network");
  fireEvent.change(field(/Azure name/), { target: { value: "vnet-demo" } });

  const select = field(/Resource group/) as HTMLSelectElement;
  // The only thing on the canvas that may fill this slot — a virtual network
  // could never appear here, which is the point of a typed slot.
  expect(
    [...select.options].map((o) => o.textContent).filter((t) => t !== null),
  ).toEqual(["Connect…", "azurerm_resource_group.resource_group"]);

  fireEvent.change(select, { target: { value: "n1" } });

  expect(screen.getByRole("status")).toHaveTextContent("2 resources · ready");
  expect(
    within(screen.getByTestId("builder-node-n2")).getByText(
      "resource_group",
    ),
  ).toBeInTheDocument();
});

it("says a slot has nothing to connect to rather than offering nonsense", () => {
  render(<Harness />);
  addFromPalette("Subnet");
  const select = field(/Virtual network/) as HTMLSelectElement;
  expect(select).toBeDisabled();
  expect(select.options[0]?.textContent).toMatch(/No virtual_network/);
});

it("keeps the graph consistent when a resource is deleted", () => {
  render(<Harness />);
  addFromPalette("Resource group");
  fireEvent.change(field(/Azure name/), { target: { value: "rg-demo" } });
  addFromPalette("Virtual network");
  fireEvent.change(field(/Azure name/), { target: { value: "vnet-demo" } });
  fireEvent.change(field(/Resource group/), { target: { value: "n1" } });

  // Delete the resource group the virtual network points at.
  fireEvent.click(screen.getByTestId("builder-node-n1"));
  fireEvent.click(screen.getByLabelText("Delete resource_group"));

  expect(screen.queryByTestId("builder-node-n1")).not.toBeInTheDocument();
  // The connection went with it, and the virtual network says what it now owes.
  expect(screen.getByRole("status")).toHaveTextContent("1 resource · 1 problem");
  expect(
    screen.getByLabelText("virtual_network has 1 problem"),
  ).toBeInTheDocument();
});

it("refuses to leave two resources of a type sharing a name", () => {
  render(<Harness />);
  addFromPalette("Subnet");
  addFromPalette("Subnet");
  expect(screen.getByLabelText(/Terraform name/)).toHaveValue("subnet_2");

  fireEvent.change(field(/Terraform name/), { target: { value: "subnet" } });
  expect(
    screen.getByText('another Subnet is already called "subnet"'),
  ).toBeInTheDocument();
});
