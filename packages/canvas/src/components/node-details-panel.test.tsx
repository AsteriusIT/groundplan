import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { Graph, GraphNode } from "../types";
import {
  PANEL_MODE_STORAGE_KEY,
  PANEL_WIDTH_STORAGE_KEY,
  PanelPrefsProvider,
} from "../panel/panel-prefs";
import { NodeDetailsPanel } from "./node-details-panel";

const vnet: GraphNode = {
  id: "azurerm_virtual_network.main",
  name: "main",
  type: "azurerm_virtual_network",
  provider: "azurerm",
  module_path: [],
  change: "update",
};
const subnet: GraphNode = {
  id: "azurerm_subnet.internal",
  name: "internal",
  type: "azurerm_subnet",
  provider: "azurerm",
  module_path: [],
  change: "noop",
  impacted: true,
  impact_distance: 1,
};
const shopDb: GraphNode = {
  id: "azurerm_mssql_database.shop_db",
  name: "shop_db",
  type: "azurerm_mssql_database",
  provider: "azurerm",
  module_path: [],
  change: "update",
  attribute_diff: [
    { key: "sku_name", before: "S0", after: "P1" },
    { key: "administrator_login_password", before: "(sensitive)", after: "(sensitive)" },
    { key: "primary_key", before: null, after: "(known after apply)" },
  ],
};

const graph: Graph = {
  version: 3,
  nodes: [vnet, subnet, shopDb],
  edges: [
    { from: "azurerm_subnet.internal", to: "azurerm_virtual_network.main", kind: "depends_on" },
  ],
};

it("renders the attribute diff with values and masks sensitive ones (GP-32/33)", () => {
  render(
    <NodeDetailsPanel graph={graph} node={shopDb} onClose={() => {}} onSelect={() => {}} />,
  );
  expect(screen.getByText(/^Changes/)).toBeInTheDocument();
  expect(screen.getByText("sku_name")).toBeInTheDocument();
  expect(screen.getByText("S0")).toBeInTheDocument();
  expect(screen.getByText("P1")).toBeInTheDocument();
  // Sensitive value is masked on both sides; known-after-apply rendered as such.
  expect(screen.getAllByText("(sensitive)")).toHaveLength(2);
  expect(screen.getByText("(known after apply)")).toBeInTheDocument();
});

it("shows the why-impacted sentence and navigates to the changed ancestor", () => {
  const onSelect = vi.fn();
  render(
    <NodeDetailsPanel graph={graph} node={subnet} onClose={() => {}} onSelect={onSelect} />,
  );
  expect(screen.getByText(/Why impacted/i)).toBeInTheDocument();
  // The sentence names the changed ancestor; clicking it selects that node.
  const why = screen.getByText(/This unchanged resource is impacted/i);
  fireEvent.click(within(why).getByRole("button", { name: "virtual_network.main" }));
  expect(onSelect).toHaveBeenCalledWith(vnet);
});

it("lists connections and navigates on click", () => {
  const onSelect = vi.fn();
  render(
    <NodeDetailsPanel graph={graph} node={subnet} onClose={() => {}} onSelect={onSelect} />,
  );
  const dependsOn = screen.getByText("Depends on").parentElement as HTMLElement;
  fireEvent.click(within(dependsOn).getByText("virtual_network.main"));
  expect(onSelect).toHaveBeenCalledWith(vnet);
});

it("renders old snapshots (no attribute_diff) without a Changes section", () => {
  const legacy: GraphNode = {
    id: "aws_s3_bucket.logs",
    name: "logs",
    type: "aws_s3_bucket",
    provider: "aws",
    module_path: [],
    change: "noop",
  };
  const legacyGraph: Graph = { version: 2, nodes: [legacy], edges: [] };
  render(
    <NodeDetailsPanel graph={legacyGraph} node={legacy} onClose={() => {}} onSelect={() => {}} />,
  );
  expect(screen.queryByText(/^Changes/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Why impacted/i)).not.toBeInTheDocument();
  // Address section still renders.
  expect(screen.getByText("Terraform address")).toBeInTheDocument();
  expect(screen.getByText("aws_s3_bucket.logs")).toBeInTheDocument();
});

it("renders a Security rules section for an NSG, flagging internet rows (GP-45)", () => {
  const nsg: GraphNode = {
    id: "azurerm_network_security_group.open",
    name: "open",
    type: "azurerm_network_security_group",
    provider: "azurerm",
    module_path: [],
    change: null,
    rules: [
      { name: "allow-internal", priority: 200, direction: "Inbound", access: "Allow", protocol: "Tcp", ports: "22", source: "10.0.0.0/8", destination: "*" },
      { name: "allow-https", priority: 100, direction: "Inbound", access: "Allow", protocol: "Tcp", ports: "443", source: "Internet", destination: "*" },
    ],
  };
  const graph: Graph = { version: 4, nodes: [nsg], edges: [] };
  render(<NodeDetailsPanel graph={graph} node={nsg} onClose={() => {}} onSelect={() => {}} />);

  expect(screen.getByText("Security rules")).toBeInTheDocument();
  // Sorted by priority: allow-https (100) appears before allow-internal (200).
  const names = screen.getAllByText(/allow-(https|internal)/).map((n) => n.textContent);
  expect(names).toEqual(["allow-https", "allow-internal"]);
  // Exactly one row is flagged as an internet source.
  expect(screen.getAllByLabelText(/internet source/i)).toHaveLength(1);
});

it("hides the Security rules section when a node has no rules", () => {
  const graph: Graph = { version: 4, nodes: [subnet], edges: [] };
  render(<NodeDetailsPanel graph={graph} node={subnet} onClose={() => {}} onSelect={() => {}} />);
  expect(screen.queryByText("Security rules")).not.toBeInTheDocument();
});

// --- Source section (GP-121) ------------------------------------------------

const HCL = [
  'resource "azurerm_subnet" "internal" {',
  '  name             = "internal"   # the app tier',
  '  address_prefixes = ["10.0.1.0/24"]',
  "}",
].join("\n");

const sourced: GraphNode = {
  ...subnet,
  source: {
    file: "modules/network/main.tf",
    start_line: 12,
    end_line: 15,
    code: HCL,
  },
};

it("shows the file, the line range and the block's code (GP-121)", () => {
  const graph: Graph = { version: 8, nodes: [sourced], edges: [] };
  render(
    <NodeDetailsPanel
      graph={graph}
      node={sourced}
      onClose={() => {}}
      onSelect={() => {}}
      showChange={false}
    />,
  );

  expect(screen.getByText("Source")).toBeInTheDocument();
  expect(screen.getByText(/modules\/network\/main\.tf · L12–L15/)).toBeInTheDocument();
  // Highlighting splits the block across spans; the rendered text must still be
  // the file's text, byte for byte — a snippet that differs is worse than none.
  const code = document.querySelector("pre code");
  expect(code?.textContent).toBe(HCL);
});

it("copies the raw source, not the highlighted markup (GP-121)", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });

  const graph: Graph = { version: 8, nodes: [sourced], edges: [] };
  render(
    <NodeDetailsPanel graph={graph} node={sourced} onClose={() => {}} onSelect={() => {}} />,
  );

  fireEvent.click(screen.getByLabelText("Copy source"));
  expect(writeText).toHaveBeenCalledWith(HCL);
  // The button sits in the <summary>; copying must not collapse the section out
  // from under the reader. Browsers skip summary's toggle for an interactive
  // descendant — this pins that, since the layout depends on it.
  expect(document.querySelector("details")?.open).toBe(true);
});

it("renders a single-line block's span without a range (GP-121)", () => {
  const oneLiner: GraphNode = {
    ...subnet,
    source: { file: "main.tf", start_line: 7, end_line: 7, code: 'data "aws_x" "y" {}' },
  };
  const graph: Graph = { version: 8, nodes: [oneLiner], edges: [] };
  render(
    <NodeDetailsPanel graph={graph} node={oneLiner} onClose={() => {}} onSelect={() => {}} />,
  );
  expect(screen.getByText(/main\.tf · L7$/)).toBeInTheDocument();
});

it("omits the Source section when a node has no source (plan flow, GP-121)", () => {
  const graph: Graph = { version: 3, nodes: [shopDb], edges: [] };
  render(
    <NodeDetailsPanel graph={graph} node={shopDb} onClose={() => {}} onSelect={() => {}} />,
  );
  expect(screen.queryByText("Source")).not.toBeInTheDocument();
  expect(document.querySelector("pre")).toBeNull();
});

// --- Source overlay + panel sizing ------------------------------------------

it("expands the source into a wide overlay, verbatim, with its own copy", () => {
  const graph: Graph = { version: 8, nodes: [sourced], edges: [] };
  render(
    <NodeDetailsPanel graph={graph} node={sourced} onClose={() => {}} onSelect={() => {}} />,
  );

  fireEvent.click(screen.getByLabelText("Expand source"));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("modules/network/main.tf")).toBeInTheDocument();
  expect(within(dialog).getByText(/L12–L15/)).toBeInTheDocument();
  expect(within(dialog).getByLabelText("Copy source")).toBeInTheDocument();
  // Same byte-for-byte guarantee as the inline snippet.
  const code = dialog.querySelector("pre code");
  expect(code?.textContent).toBe(HCL);
  // Expanding must not collapse the inline section behind the overlay.
  expect(document.querySelector("details")?.open).toBe(true);
});

it("keeps a fixed 416px panel by default — no resize handle", () => {
  render(
    <NodeDetailsPanel graph={graph} node={subnet} onClose={() => {}} onSelect={() => {}} />,
  );
  const panel = screen.getByRole("complementary");
  expect(panel.className).toContain("w-[26rem]");
  expect(panel.style.width).toBe("");
  expect(screen.queryByRole("separator")).not.toBeInTheDocument();
});

function renderResizable(width = 512) {
  localStorage.setItem(PANEL_MODE_STORAGE_KEY, "resizable");
  localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(width));
  return render(
    <PanelPrefsProvider>
      <NodeDetailsPanel graph={graph} node={subnet} onClose={() => {}} onSelect={() => {}} />
    </PanelPrefsProvider>,
  );
}

it("resizable mode: the stored width applies and a handle appears", () => {
  localStorage.clear();
  renderResizable(512);
  const panel = screen.getByRole("complementary");
  expect(panel.style.width).toBe("512px");
  const handle = screen.getByRole("separator", { name: /resize panel/i });
  expect(handle).toHaveAttribute("aria-valuenow", "512");
  expect(handle).toHaveAttribute("aria-valuemin", "320");
  expect(handle).toHaveAttribute("aria-valuemax", "720");
});

it("dragging the handle resizes the panel and persists on release", () => {
  localStorage.clear();
  renderResizable(512);
  const handle = screen.getByRole("separator", { name: /resize panel/i });

  fireEvent.pointerDown(handle, { clientX: 800, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 750, pointerId: 1 });
  expect(screen.getByRole("complementary").style.width).toBe("562px");
  // Live preview only — nothing stored until release.
  expect(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBe("512");

  fireEvent.pointerUp(handle, { clientX: 750, pointerId: 1 });
  expect(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBe("562");
  expect(screen.getByRole("complementary").style.width).toBe("562px");
});

it("arrow keys nudge the width by 16px, clamped, persisting", () => {
  localStorage.clear();
  renderResizable(712);
  const handle = screen.getByRole("separator", { name: /resize panel/i });

  fireEvent.keyDown(handle, { key: "ArrowLeft" }); // wider, hits the 720 cap
  expect(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBe("720");
  fireEvent.keyDown(handle, { key: "ArrowRight" }); // narrower
  expect(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBe("704");
  expect(screen.getByRole("complementary").style.width).toBe("704px");
});

const existingSubnet: GraphNode = {
  id: "data.azurerm_subnet.existing",
  name: "existing",
  type: "azurerm_subnet",
  provider: "azurerm",
  module_path: [],
  change: null,
};

const dataGraph: Graph = {
  version: 8,
  nodes: [existingSubnet, { ...vnet, change: null }],
  edges: [
    {
      from: "azurerm_virtual_network.main",
      to: "data.azurerm_subnet.existing",
      kind: "depends_on",
    },
  ],
};

it("says a data source is one: eyebrow + explainer (not 'Resource')", () => {
  render(
    <NodeDetailsPanel
      graph={dataGraph}
      node={existingSubnet}
      onClose={() => {}}
      onSelect={() => {}}
    />,
  );
  expect(screen.getByText("Data source")).toBeInTheDocument();
  expect(screen.queryByText("Resource")).not.toBeInTheDocument();
  expect(
    screen.getByText(/read from the provider at plan time/i),
  ).toBeInTheDocument();
});

it("prefixes a data source in the connections list", () => {
  render(
    <NodeDetailsPanel
      graph={dataGraph}
      node={{ ...vnet, change: null }}
      onClose={() => {}}
      onSelect={() => {}}
    />,
  );
  expect(
    screen.getByRole("button", { name: "data.subnet.existing" }),
  ).toBeInTheDocument();
});

it("keeps the plain 'Resource' eyebrow on a managed resource", () => {
  render(
    <NodeDetailsPanel graph={graph} node={vnet} onClose={() => {}} onSelect={() => {}} />,
  );
  expect(screen.getByText("Resource")).toBeInTheDocument();
  expect(
    screen.queryByText(/read from the provider at plan time/i),
  ).not.toBeInTheDocument();
});
