/**
 * GP-139: the deterministic lint pass on generated (or any docs-flow) HCL.
 *
 * A small in-house rule set over the graph Producer B already built — each
 * node carries its verbatim source block (v8, GP-120) and the NSG extraction
 * (GP-43), so no second parser and no external binary. Every rule is a pure
 * function; adding one is a PR with its two tests, not a config system.
 *
 * Findings anchor to Terraform addresses (the node ids), so the canvas can
 * badge nodes the way annotations anchor (GP-56) — and severities stay
 * honest: `high` is "you are exposed", `warn` is "this weakens you",
 * `info` is "the convention says otherwise". Clean HCL yields nothing.
 */
import type { Graph, GraphNode } from "@groundplan/graph-parser";

export type LintSeverity = "info" | "warn" | "high";

export type LintFinding = {
  ruleId: string;
  severity: LintSeverity;
  /** The resource the finding is anchored to — its node id / Terraform address. */
  terraformAddress: string;
  message: string;
  fixHint: string;
};

/** A rule: look at one node (with its source block) and speak or stay silent. */
type LintRule = (node: GraphNode) => Omit<LintFinding, "terraformAddress">[];

/** The raw right-hand side of a top-level-ish `name = value`, or null. */
function attrRaw(code: string, name: string): string | null {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, "m").exec(code);
  return match?.[1] ?? null;
}

/** The unquoted value of `name = "literal"`; null for expressions/absence. */
function attrString(code: string, name: string): string | null {
  const raw = attrRaw(code, name);
  if (!raw) return null;
  const quoted = /^"([^"]*)"$/.exec(raw);
  return quoted?.[1] ?? null;
}

/** True when `name = true|false` is written out (absent ≠ false — defaults
 * belong to the provider, and guessing them is how a linter cries wolf). */
function attrBool(code: string, name: string): boolean | null {
  const raw = attrRaw(code, name);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

const INTERNET_SOURCES = new Set(["*", "0.0.0.0/0", "internet", "any"]);

/** Does this port spec cover `port`? Handles `*`, lists, and `a-b` ranges. */
function coversPort(ports: string, port: number): boolean {
  return ports.split(",").some((part) => {
    const p = part.trim();
    if (p === "*") return true;
    const range = /^(\d+)-(\d+)$/.exec(p);
    if (range) return Number(range[1]) <= port && port <= Number(range[2]);
    return Number(p) === port;
  });
}

// ---- The rules -------------------------------------------------------------

const nsgOpenToInternet: LintRule = (node) => {
  if (node.type !== "azurerm_network_security_group") return [];
  if (node.internet_exposed !== true) return [];
  return [
    {
      ruleId: "nsg-open-to-internet",
      severity: "high",
      message:
        "This network security group has an inbound Allow rule open to the internet.",
      fixHint:
        "Restrict source_address_prefix to the CIDR ranges that actually need access.",
    },
  ];
};

const sshRdpOpenToInternet: LintRule = (node) => {
  if (node.type !== "azurerm_network_security_group") return [];
  const open = (node.rules ?? []).filter(
    (r) =>
      r.direction.toLowerCase() === "inbound" &&
      r.access.toLowerCase() === "allow" &&
      INTERNET_SOURCES.has(r.source.toLowerCase()) &&
      (coversPort(r.ports, 22) || coversPort(r.ports, 3389)),
  );
  return open.map((r) => ({
    ruleId: "ssh-rdp-open-to-internet",
    severity: "high" as const,
    message: `Rule "${r.name}" allows SSH/RDP (${r.ports}) from the internet.`,
    fixHint:
      "Management ports should sit behind a bastion or a VPN, never open to 0.0.0.0/0.",
  }));
};

/** Secret-ish attribute names assigned a bare string literal. */
const SECRET_ATTR =
  /^\s*(\w*(?:password|client_secret|primary_key|account_key|api_key|sas_token|connection_string)\w*)\s*=\s*"([^"]{8,})"\s*$/gim;

const hardcodedSecret: LintRule = (node) => {
  const code = node.source?.code ?? "";
  const findings: ReturnType<LintRule> = [];
  for (const match of code.matchAll(SECRET_ATTR)) {
    const [, attr, value] = match;
    if (value!.includes("${")) continue; // interpolation, not a literal
    findings.push({
      ruleId: "hardcoded-secret",
      severity: "high",
      message: `"${attr}" is assigned a literal value in the code.`,
      fixHint:
        "Use a sensitive variable with no default, random_password, or a Key Vault reference.",
    });
  }
  return findings;
};

const storagePublicBlobAccess: LintRule = (node) => {
  if (node.type !== "azurerm_storage_account") return [];
  const code = node.source?.code ?? "";
  const isPublic =
    attrBool(code, "allow_nested_items_to_be_public") === true ||
    attrBool(code, "allow_blob_public_access") === true;
  if (!isPublic) return [];
  return [
    {
      ruleId: "storage-public-blob-access",
      severity: "high",
      message: "This storage account allows public (anonymous) blob access.",
      fixHint: "Set allow_nested_items_to_be_public = false.",
    },
  ];
};

const storageContainerPublic: LintRule = (node) => {
  if (node.type !== "azurerm_storage_container") return [];
  const access = attrString(node.source?.code ?? "", "container_access_type");
  if (access !== "blob" && access !== "container") return [];
  return [
    {
      ruleId: "storage-container-public",
      severity: "high",
      message: `This container is publicly readable (container_access_type = "${access}").`,
      fixHint: 'Set container_access_type = "private".',
    },
  ];
};

const storageHttpAllowed: LintRule = (node) => {
  if (node.type !== "azurerm_storage_account") return [];
  const code = node.source?.code ?? "";
  const httpAllowed =
    attrBool(code, "https_traffic_only_enabled") === false ||
    attrBool(code, "enable_https_traffic_only") === false;
  if (!httpAllowed) return [];
  return [
    {
      ruleId: "storage-http-allowed",
      severity: "warn",
      message: "This storage account accepts plain-HTTP traffic.",
      fixHint: "Set https_traffic_only_enabled = true.",
    },
  ];
};

const WEAK_TLS = new Set(["TLS1_0", "TLS1_1", "1.0", "1.1"]);

const weakTls: LintRule = (node) => {
  const code = node.source?.code ?? "";
  const version =
    attrString(code, "min_tls_version") ??
    attrString(code, "minimum_tls_version");
  if (!version || !WEAK_TLS.has(version)) return [];
  return [
    {
      ruleId: "weak-tls",
      severity: "warn",
      message: `TLS minimum is set to ${version}.`,
      fixHint: "Require TLS 1.2 or newer.",
    },
  ];
};

const HTTPS_ONLY_TYPES = new Set([
  "azurerm_app_service",
  "azurerm_linux_web_app",
  "azurerm_windows_web_app",
  "azurerm_function_app",
  "azurerm_linux_function_app",
  "azurerm_windows_function_app",
]);

const httpsOnlyOff: LintRule = (node) => {
  if (!HTTPS_ONLY_TYPES.has(node.type)) return [];
  if (attrBool(node.source?.code ?? "", "https_only") !== false) return [];
  return [
    {
      ruleId: "app-https-only-off",
      severity: "warn",
      message: "https_only is explicitly disabled — the app serves plain HTTP.",
      fixHint: "Set https_only = true.",
    },
  ];
};

const keyVaultPublicNetwork: LintRule = (node) => {
  if (node.type !== "azurerm_key_vault") return [];
  const code = node.source?.code ?? "";
  if (attrBool(code, "public_network_access_enabled") !== true) return [];
  return [
    {
      ruleId: "key-vault-public-network",
      severity: "warn",
      message: "This key vault is reachable from public networks.",
      fixHint:
        "Set public_network_access_enabled = false and use a private endpoint.",
    },
  ];
};

const SQL_TYPES = new Set([
  "azurerm_mssql_server",
  "azurerm_postgresql_flexible_server",
  "azurerm_mysql_flexible_server",
]);

const sqlPublicNetwork: LintRule = (node) => {
  if (!SQL_TYPES.has(node.type)) return [];
  const code = node.source?.code ?? "";
  if (attrBool(code, "public_network_access_enabled") !== true) return [];
  return [
    {
      ruleId: "sql-public-network",
      severity: "warn",
      message: "This database server is reachable from public networks.",
      fixHint:
        "Set public_network_access_enabled = false and use a private endpoint.",
    },
  ];
};

const vmPasswordAuth: LintRule = (node) => {
  if (node.type !== "azurerm_linux_virtual_machine") return [];
  const code = node.source?.code ?? "";
  if (attrBool(code, "disable_password_authentication") !== false) return [];
  return [
    {
      ruleId: "vm-password-auth",
      severity: "warn",
      message: "Password authentication is enabled on this Linux VM.",
      fixHint: "Use SSH keys: disable_password_authentication = true.",
    },
  ];
};

/** Types where a missing `tags` block is worth a nudge — common, definitely
 * taggable resources only, so the rule cannot cry wolf on an association. */
const TAGGABLE_TYPES = new Set([
  "azurerm_resource_group",
  "azurerm_storage_account",
  "azurerm_virtual_network",
  "azurerm_key_vault",
  "azurerm_mssql_server",
  "azurerm_linux_virtual_machine",
  "azurerm_windows_virtual_machine",
  "azurerm_kubernetes_cluster",
  "azurerm_linux_web_app",
  "azurerm_windows_web_app",
  "azurerm_service_plan",
]);

const missingTags: LintRule = (node) => {
  if (!TAGGABLE_TYPES.has(node.type)) return [];
  const code = node.source?.code ?? "";
  if (/^\s*tags\s*=/m.test(code)) return [];
  return [
    {
      ruleId: "missing-tags",
      severity: "info",
      message: "This resource carries no tags.",
      fixHint:
        "Tag at least environment and managed_by so cost and ownership stay traceable.",
    },
  ];
};

const RULES: LintRule[] = [
  nsgOpenToInternet,
  sshRdpOpenToInternet,
  hardcodedSecret,
  storagePublicBlobAccess,
  storageContainerPublic,
  storageHttpAllowed,
  weakTls,
  httpsOnlyOff,
  keyVaultPublicNetwork,
  sqlPublicNetwork,
  vmPasswordAuth,
  missingTags,
];

const SEVERITY_ORDER: Record<LintSeverity, number> = {
  high: 0,
  warn: 1,
  info: 2,
};

/** Run every rule over every node. Deterministic: worst findings first, then
 * by address, so the same HCL always lists the same findings the same way. */
export function lintGraph(graph: Graph): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const node of graph.nodes) {
    for (const rule of RULES) {
      for (const finding of rule(node)) {
        findings.push({ ...finding, terraformAddress: node.id });
      }
    }
  }
  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.terraformAddress.localeCompare(b.terraformAddress) ||
      a.ruleId.localeCompare(b.ruleId),
  );
}
