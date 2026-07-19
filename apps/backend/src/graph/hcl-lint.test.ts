/**
 * GP-139: the deterministic lint rules, one positive and one negative case
 * each — through the real parser, so what the rules see is exactly what the
 * studio's parse endpoint hands them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "@groundplan/graph-parser";

import { lintGraph, type LintFinding } from "./hcl-lint.js";

/** Parse one `main.tf` and lint the snapshot. */
function lintOf(hcl: string): LintFinding[] {
  const { snapshot } = parse([{ path: "main.tf", content: hcl }]);
  return lintGraph(snapshot);
}

const has = (findings: LintFinding[], ruleId: string) =>
  findings.some((f) => f.ruleId === ruleId);

test("nsg-open-to-internet: fires on 0.0.0.0/0 inbound Allow, anchored to the NSG", () => {
  const findings = lintOf(`
resource "azurerm_network_security_group" "open" {
  name                = "nsg-open"
  location            = "westeurope"
  resource_group_name = "rg"
  tags                = { environment = "dev" }

  security_rule {
    name                       = "allow-all"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "0.0.0.0/0"
    destination_address_prefix = "*"
  }
}
`);
  const finding = findings.find((f) => f.ruleId === "nsg-open-to-internet");
  assert.ok(finding);
  assert.equal(finding.severity, "high");
  assert.equal(finding.terraformAddress, "azurerm_network_security_group.open");
});

test("nsg-open-to-internet: silent on a scoped source", () => {
  const findings = lintOf(`
resource "azurerm_network_security_group" "scoped" {
  name                = "nsg-scoped"
  location            = "westeurope"
  resource_group_name = "rg"

  security_rule {
    name                       = "allow-office"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "10.1.0.0/16"
    destination_address_prefix = "*"
  }
}
`);
  assert.ok(!has(findings, "nsg-open-to-internet"));
});

test("ssh-rdp-open-to-internet: fires on port 22 from the internet, not on 443", () => {
  const nsg = (port: string) => `
resource "azurerm_network_security_group" "mgmt" {
  name                = "nsg-mgmt"
  location            = "westeurope"
  resource_group_name = "rg"

  security_rule {
    name                       = "inbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "${port}"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}
`;
  assert.ok(has(lintOf(nsg("22")), "ssh-rdp-open-to-internet"));
  assert.ok(has(lintOf(nsg("20-30")), "ssh-rdp-open-to-internet"));
  assert.ok(!has(lintOf(nsg("443")), "ssh-rdp-open-to-internet"));
});

test("hardcoded-secret: fires on a literal password, not on a variable", () => {
  const positive = lintOf(`
resource "azurerm_mssql_server" "db" {
  name                         = "sql-demo"
  administrator_login_password = "SuperSecret123!"
}
`);
  assert.ok(has(positive, "hardcoded-secret"));

  const negative = lintOf(`
resource "azurerm_mssql_server" "db" {
  name                         = "sql-demo"
  administrator_login_password = var.admin_password
}
`);
  assert.ok(!has(negative, "hardcoded-secret"));
});

test("storage-public-blob-access: fires on true, silent when disabled", () => {
  const account = (allow: string) => `
resource "azurerm_storage_account" "sa" {
  name                            = "sademo"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = ${allow}
  tags                            = { environment = "dev" }
}
`;
  assert.ok(has(lintOf(account("true")), "storage-public-blob-access"));
  assert.ok(!has(lintOf(account("false")), "storage-public-blob-access"));
});

test("storage-container-public: fires on blob access, silent on private", () => {
  const container = (access: string) => `
resource "azurerm_storage_container" "c" {
  name                  = "data"
  container_access_type = "${access}"
}
`;
  assert.ok(has(lintOf(container("blob")), "storage-container-public"));
  assert.ok(!has(lintOf(container("private")), "storage-container-public"));
});

test("storage-http-allowed: fires only when HTTPS-only is explicitly off", () => {
  const account = (flag: string) => `
resource "azurerm_storage_account" "sa" {
  name                       = "sademo"
  https_traffic_only_enabled = ${flag}
  tags                       = { environment = "dev" }
}
`;
  assert.ok(has(lintOf(account("false")), "storage-http-allowed"));
  assert.ok(!has(lintOf(account("true")), "storage-http-allowed"));
});

test("weak-tls: fires on TLS1_0/1.1, silent on TLS1_2", () => {
  const account = (v: string) => `
resource "azurerm_storage_account" "sa" {
  name            = "sademo"
  min_tls_version = "${v}"
  tags            = { environment = "dev" }
}
`;
  assert.ok(has(lintOf(account("TLS1_0")), "weak-tls"));
  assert.ok(!has(lintOf(account("TLS1_2")), "weak-tls"));

  const server = (v: string) => `
resource "azurerm_mssql_server" "db" {
  name                = "sql-demo"
  minimum_tls_version = "${v}"
  tags                = { environment = "dev" }
}
`;
  assert.ok(has(lintOf(server("1.1")), "weak-tls"));
  assert.ok(!has(lintOf(server("1.2")), "weak-tls"));
});

test("app-https-only-off: fires on explicit false only", () => {
  const app = (line: string) => `
resource "azurerm_linux_web_app" "web" {
  name = "web-demo"
  ${line}
  tags = { environment = "dev" }
}
`;
  assert.ok(has(lintOf(app("https_only = false")), "app-https-only-off"));
  assert.ok(!has(lintOf(app("https_only = true")), "app-https-only-off"));
  // Absent stays silent: defaults belong to the provider, not the linter.
  assert.ok(!has(lintOf(app("")), "app-https-only-off"));
});

test("key-vault-public-network: fires on public access, silent when private", () => {
  const vault = (flag: string) => `
resource "azurerm_key_vault" "kv" {
  name                          = "kv-demo"
  public_network_access_enabled = ${flag}
  tags                          = { environment = "dev" }
}
`;
  assert.ok(has(lintOf(vault("true")), "key-vault-public-network"));
  assert.ok(!has(lintOf(vault("false")), "key-vault-public-network"));
});

test("sql-public-network: fires on public access, silent when private", () => {
  const server = (flag: string) => `
resource "azurerm_postgresql_flexible_server" "pg" {
  name                          = "pg-demo"
  public_network_access_enabled = ${flag}
}
`;
  assert.ok(has(lintOf(server("true")), "sql-public-network"));
  assert.ok(!has(lintOf(server("false")), "sql-public-network"));
});

test("vm-password-auth: fires when password auth is enabled", () => {
  const vm = (flag: string) => `
resource "azurerm_linux_virtual_machine" "vm" {
  name                            = "vm-demo"
  disable_password_authentication = ${flag}
  tags                            = { environment = "dev" }
}
`;
  assert.ok(has(lintOf(vm("false")), "vm-password-auth"));
  assert.ok(!has(lintOf(vm("true")), "vm-password-auth"));
});

test("missing-tags: nudges a bare resource group, accepts a tagged one", () => {
  const positive = lintOf(`
resource "azurerm_resource_group" "rg" {
  name     = "rg-demo"
  location = "westeurope"
}
`);
  const finding = positive.find((f) => f.ruleId === "missing-tags");
  assert.ok(finding);
  assert.equal(finding.severity, "info");

  const negative = lintOf(`
resource "azurerm_resource_group" "rg" {
  name     = "rg-demo"
  location = "westeurope"
  tags     = { environment = "dev" }
}
`);
  assert.ok(!has(negative, "missing-tags"));
});

test("clean HCL yields an empty findings array — no default noise", () => {
  const findings = lintOf(`
resource "azurerm_resource_group" "rg" {
  name     = "rg-demo"
  location = "westeurope"
  tags     = { environment = "dev", managed_by = "terraform" }
}

resource "azurerm_virtual_network" "vnet" {
  name                = "vnet-demo"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = { environment = "dev", managed_by = "terraform" }
}
`);
  assert.deepEqual(findings, []);
});

test("findings sort worst-first, deterministically", () => {
  const findings = lintOf(`
resource "azurerm_resource_group" "rg" {
  name     = "rg-demo"
  location = "westeurope"
}

resource "azurerm_storage_account" "sa" {
  name                            = "sademo"
  allow_nested_items_to_be_public = true
  tags                            = { environment = "dev" }
}
`);
  assert.equal(findings[0]?.ruleId, "storage-public-blob-access");
  assert.equal(findings.at(-1)?.ruleId, "missing-tags");
});
