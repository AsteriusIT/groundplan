/**
 * What a playground file *is* (GP-244): which stack it belongs to, whether it
 * may be here at all, and the example set the mode opens with.
 *
 * Pure, and apart from the views, because both of them — and the layout that
 * owns the file set — answer the same questions about the same files.
 */
import type { IacType, PlaygroundFile } from "@/api/types";

/** Extensions the backend accepts (GP-123, widened for Kubernetes). */
export const TF_EXTENSIONS = [".tf", ".tfvars"];
export const K8S_EXTENSIONS = [".yaml", ".yml"];
export const ALLOWED_EXTENSIONS = [...TF_EXTENSIONS, ...K8S_EXTENSIONS];

export function isAllowedPath(path: string): boolean {
  return ALLOWED_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Which stack a file belongs to, by extension — the whole detection story. */
export function fileIacType(path: string): IacType {
  return K8S_EXTENSIONS.some((ext) => path.endsWith(ext))
    ? "kubernetes"
    : "terraform";
}

/** The mode for a file set: the preferred side if it has files, else the other. */
export function modeFor(
  files: readonly PlaygroundFile[],
  preferred: IacType,
): IacType {
  const has = (t: IacType) => files.some((f) => fileIacType(f.path) === t);
  if (has(preferred)) return preferred;
  const other: IacType = preferred === "terraform" ? "kubernetes" : "terraform";
  return has(other) ? other : preferred;
}

export const NOT_IN_VIEW: Record<IacType, string> = {
  terraform: "Not in the Terraform view",
  kubernetes: "Not in the Kubernetes view",
};

/**
 * A small linked Azure stack so the page is never empty: resource group →
 * vnet → subnet → NSG, with cross-file references (network.tf reaches back
 * into main.tf), which is exactly what the playground exists to show.
 */
export const EXAMPLE_FILES: PlaygroundFile[] = [
  {
    path: "main.tf",
    content: `resource "azurerm_resource_group" "demo" {
  name     = "rg-playground"
  location = "westeurope"
}

resource "azurerm_virtual_network" "demo" {
  name                = "vnet-playground"
  location            = azurerm_resource_group.demo.location
  resource_group_name = azurerm_resource_group.demo.name
  address_space       = ["10.0.0.0/16"]
}
`,
  },
  {
    path: "network.tf",
    content: `resource "azurerm_subnet" "app" {
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.demo.name
  virtual_network_name = azurerm_virtual_network.demo.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_network_security_group" "app" {
  name                = "nsg-app"
  location            = azurerm_resource_group.demo.location
  resource_group_name = azurerm_resource_group.demo.name
}

resource "azurerm_subnet_network_security_group_association" "app" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.app.id
}
`,
  },
];
