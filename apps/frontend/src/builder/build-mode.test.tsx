import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { CATALOG, type ResourceDef } from "@groundplan/builder";

import { BuildMode } from "./build-mode";
import { useBuilderGraph } from "./use-builder-graph";
import type { CatalogState } from "./use-catalog";

/**
 * A catalog with no provider behind it (GP-238). The curated entries are
 * compiled in, so this is exactly what Build mode looks like on a deployment
 * that never enabled the catalog worker — and every test below therefore also
 * proves the builder still works without one.
 */
export function offlineCatalog(over: Partial<CatalogState> = {}): CatalogState {
  return {
    providers: null,
    active: null,
    defs: [...CATALOG] as ResourceDef[],
    warming: false,
    pinned: false,
    unavailable: false,
    search: async () => [],
    ensure: async (type) => CATALOG.find((def) => def.type === type) ?? null,
    loading: new Set(),
    ...over,
  };
}

/** The real controller, wired to the real mode — this is the feature. */
function Harness({ catalog = offlineCatalog() }: { catalog?: CatalogState } = {}) {
  const builder = useBuilderGraph(catalog.defs);
  return <BuildMode builder={builder} catalog={catalog} />;
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
  // The connection is recorded, and — since a resource group is somewhere a
  // network can be *drawn* (GP-247) — it is recorded as containment: the
  // network is now inside that resource group's frame.
  expect(
    within(screen.getByLabelText("Resource details")).getByText(
      "azurerm_resource_group.resource_group",
    ),
  ).toBeInTheDocument();
});

it("wires cards, and leaves a frame to be filled by what goes into it (GP-247)", () => {
  render(<Harness />);
  addFromPalette("Resource group");
  addFromPalette("Virtual network");
  fireEvent.change(field(/Resource group/), { target: { value: "n1" } });

  // The resource group holds the network now, so it is drawn as a frame — and
  // a frame is not something you drag a wire from or to: you put things in it.
  const frame = screen.getByTestId("builder-node-n1");
  expect(frame.querySelectorAll(".react-flow__handle.connectable")).toHaveLength(
    0,
  );
  // The card inside it keeps every handle it had, so a reference containment
  // cannot express is still one drag away.
  const card = screen.getByTestId("builder-node-n2");
  expect(
    card.querySelectorAll(".react-flow__handle.connectable").length,
  ).toBeGreaterThan(0);
});

it("keeps every card above every frame, related or not (GP-247)", () => {
  render(<Harness />);
  addFromPalette("Resource group");
  addFromPalette("Virtual network");
  fireEvent.change(field(/Resource group/), { target: { value: "n1" } });
  // A third resource, in nobody's frame and free to be dragged over one.
  addFromPalette("Storage account");

  const depth = (id: string) =>
    Number(
      screen
        .getByTestId(`builder-node-${id}`)
        .closest<HTMLElement>(".react-flow__node")?.style.zIndex ?? 0,
    );

  // Overlapping a frame must never hide a resource behind it.
  expect(depth("n3")).toBeGreaterThan(depth("n1"));
  // And what is inside the frame stays inside it, on top.
  expect(depth("n2")).toBeGreaterThan(depth("n1"));
  // The storage account is the selected one — the one a drag has hold of —
  // so it passes over the other card rather than under it.
  expect(depth("n3")).toBeGreaterThan(depth("n2"));

  // Select the frame instead: it comes forward among frames, and stays under
  // every card, which is the whole point of the two levels.
  fireEvent.click(screen.getByTestId("builder-node-n1"));
  expect(depth("n1")).toBeLessThan(depth("n2"));
  expect(depth("n1")).toBeLessThan(depth("n3"));
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

  // Delete the resource group the virtual network is drawn inside. Something
  // is in it, so the question is what happens to that (GP-247).
  fireEvent.click(screen.getByTestId("builder-node-n1"));
  fireEvent.click(screen.getByLabelText("Delete resource_group"));
  fireEvent.click(screen.getByRole("button", { name: "Keep them" }));

  expect(screen.queryByTestId("builder-node-n1")).not.toBeInTheDocument();
  // The connection went with it, and the virtual network says what it now owes.
  expect(screen.getByRole("status")).toHaveTextContent("1 resource · 1 problem");
  expect(
    screen.getByLabelText("virtual_network has 1 problem"),
  ).toBeInTheDocument();
});

it("deletes the selected resource with the Delete key, and with Backspace", async () => {
  for (const key of ["Delete", "Backspace"]) {
    const view = render(<Harness />);
    addFromPalette("Resource group");
    expect(screen.getByTestId("builder-node-n1")).toBeInTheDocument();

    fireEvent.keyDown(document, { key });

    // Awaited, not asserted straight away: React Flow's deletion is async
    // (it may consult `onBeforeDelete`), so the node goes a microtask later.
    await waitFor(() =>
      expect(screen.queryByTestId("builder-node-n1")).not.toBeInTheDocument(),
    );
    // The form went with it: an open panel for a resource that no longer
    // exists is worse than no panel.
    expect(screen.queryByLabelText("Resource details")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Nothing composed yet");
    view.unmount();
  }
});

it("takes the whole branch when that is the answer given (GP-247)", async () => {
  render(<Harness />);
  addFromPalette("Resource group");
  fireEvent.change(field(/Azure name/), { target: { value: "rg-demo" } });
  addFromPalette("Virtual network");
  fireEvent.change(field(/Azure name/), { target: { value: "vnet-demo" } });
  fireEvent.change(field(/Resource group/), { target: { value: "n1" } });

  // Select the resource group the virtual network points at, then delete it
  // with the key rather than the button — the same rules, the other route in.
  fireEvent.click(screen.getByTestId("builder-node-n1"));
  fireEvent.keyDown(document, { key: "Delete" });

  fireEvent.click(
    await screen.findByRole("button", { name: "Delete everything inside" }),
  );
  await waitFor(() =>
    expect(screen.queryByTestId("builder-node-n1")).not.toBeInTheDocument(),
  );
  // The network was inside it, and "delete everything inside" meant it.
  expect(screen.getByRole("status")).toHaveTextContent("Nothing composed yet");
});

it("never deletes a resource while its own fields are being edited", async () => {
  render(<Harness />);
  addFromPalette("Resource group");
  const name = field(/Azure name/);
  fireEvent.change(name, { target: { value: "rg" } });

  // Backspacing through a value is the single most common thing a person does
  // in this form, and it must not remove what they are editing.
  fireEvent.keyDown(name, { key: "Backspace" });
  fireEvent.keyDown(name, { key: "Delete" });

  // Given the same chance to happen as a real deletion gets, and it must not.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByTestId("builder-node-n1")).toBeInTheDocument();
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

// --- The GP-133 follow-up: names, custom resources, dragging ---------------

it("shows the name the resource will carry, beside its Terraform label", () => {
  render(<Harness />);
  addFromPalette("Resource group");

  const card = screen.getByTestId("builder-node-n1");
  // Before it is named, the card says so rather than showing nothing.
  expect(within(card).getByText("unnamed")).toBeInTheDocument();

  fireEvent.change(field(/Azure name/), { target: { value: "rg-demo" } });

  expect(within(card).getByText("rg-demo")).toBeInTheDocument();
  expect(within(card).getByText(".resource_group")).toBeInTheDocument();
});

it("carries the resource type in the drag payload", () => {
  render(<Harness />);
  const palette = screen.getByLabelText("Resource palette");
  const entry = within(palette).getByRole("button", { name: /Subnet/i });

  const dataTransfer = {
    setData: vi.fn(),
    effectAllowed: "",
  } as unknown as DataTransfer;
  fireEvent.dragStart(entry, { dataTransfer });

  expect(dataTransfer.setData).toHaveBeenCalledWith(
    "application/x-groundplan-resource",
    "azurerm_subnet",
  );
});

it("composes a resource the catalog does not have", () => {
  render(<Harness />);
  addFromPalette("Custom resource");

  // It arrives typeless, and says so on the card and in the form.
  const card = screen.getByTestId("builder-node-n1");
  expect(within(card).getByText("custom resource")).toBeInTheDocument();
  expect(
    screen.getByText(/needs a Terraform type/),
  ).toBeInTheDocument();

  fireEvent.change(field(/Terraform type/), { target: { value: "Nope Nope" } });
  expect(
    screen.getByText(/is not a Terraform resource type/),
  ).toBeInTheDocument();

  fireEvent.change(field(/Terraform type/), {
    target: { value: "azurerm_management_lock" },
  });
  expect(screen.getByRole("status")).toHaveTextContent("1 resource · ready");

  // Its attributes are the user's to invent.
  fireEvent.change(field(/New attribute/), { target: { value: "lock_level" } });
  fireEvent.click(
    within(screen.getByLabelText("Resource details")).getByRole("button", {
      name: "Add",
    }),
  );
  fireEvent.change(field("lock_level"), { target: { value: "CanNotDelete" } });
  expect(field("lock_level")).toHaveValue("CanNotDelete");

  // And nothing about it is checked beyond syntax — said out loud, once.
  expect(
    screen.getByText(/checked against a provider schema/),
  ).toBeInTheDocument();
});

// --- Variables (GP-249) ----------------------------------------------------

it("composes a variable and points an argument at it", () => {
  render(<Harness />);
  addFromPalette("Resource group");
  fireEvent.change(field(/Azure name/), { target: { value: "rg-demo" } });

  addFromPalette("Variable");
  // It is not a resource: no provider type, and the form asks what it holds.
  const card = screen.getByTestId("builder-node-n2");
  expect(within(card).getByText("variable")).toBeInTheDocument();
  fireEvent.change(field(/Terraform name/), { target: { value: "location" } });
  fireEvent.change(field(/^Default/), { target: { value: "westeurope" } });

  // Back to the resource group: its location can point at that variable
  // instead of carrying a literal.
  fireEvent.click(screen.getByTestId("builder-node-n1"));
  fireEvent.change(field(/Use a variable for Location/), {
    target: { value: "n2" },
  });

  // The field is gone — the variable is the value now — and says which one.
  const panel = screen.getByLabelText("Resource details");
  expect(within(panel).queryByLabelText(/^Location/)).not.toBeInTheDocument();
  expect(
    within(panel).getByLabelText("Stop using location for Location"),
  ).toBeInTheDocument();
  // A variable is not a resource: nothing is created for it, and the status
  // line counts it apart.
  expect(screen.getByRole("status")).toHaveTextContent(
    "1 resource · 1 variable · ready to generate",
  );
  // And the card grew a row for it, so the diagram says what is parameterised.
  expect(
    within(screen.getByTestId("builder-node-n1")).getByText("location"),
  ).toBeInTheDocument();

  // Unbinding gives the literal field back.
  fireEvent.click(
    within(panel).getByLabelText("Stop using location for Location"),
  );
  expect(field(/^Location/)).toHaveValue("westeurope");
});

it("counts an argument pointed at a variable as answered", () => {
  render(<Harness />);
  addFromPalette("Resource group");
  addFromPalette("Variable");
  fireEvent.change(field(/Terraform name/), { target: { value: "project" } });

  // The resource group has no name of its own and does not need one: point
  // its name at the variable and it is answered, badge and all.
  fireEvent.click(screen.getByTestId("builder-node-n1"));
  fireEvent.change(field(/Use a variable for Azure name/), {
    target: { value: "n2" },
  });

  expect(screen.getByRole("status")).toHaveTextContent(
    "1 resource · 1 variable · ready to generate",
  );
  expect(
    screen.queryByLabelText(/resource_group has 1 problem/),
  ).not.toBeInTheDocument();
  // …and the card says what its name is, rather than that it has none.
  const card = screen.getByTestId("builder-node-n1");
  expect(within(card).queryByText("unnamed")).not.toBeInTheDocument();
  expect(within(card).getByText("var.project")).toBeInTheDocument();
});

it("keeps a variable out of what a variable could point at", () => {
  render(<Harness />);
  addFromPalette("Variable");
  addFromPalette("Variable");

  // Two variables, and neither offers to point at the other: Terraform does
  // not allow it, so the form does not pretend it might.
  const panel = screen.getByLabelText("Resource details");
  expect(
    within(panel).queryByLabelText(/Use a variable for/),
  ).not.toBeInTheDocument();
  // They are named apart, in their own namespace.
  expect(within(panel).getByLabelText(/Terraform name/)).toHaveValue("variable_2");
});

/*
 * Selecting a wire and deleting it is verified in a browser, not here: React
 * Flow draws an edge only once it has measured the handles at both ends, and
 * jsdom measures everything as zero — so there is no edge in this DOM to click
 * on. What the gesture ends in, `disconnect`, is covered in `builder-ops`.
 */
