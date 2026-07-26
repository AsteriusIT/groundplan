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

/** What one rule says about one node: the sentence, and what to do about it. */
export type LintNote = { message: string; fixHint: string };

/**
 * A rule: its identity, and a pure function that looks at one node (with its
 * source block) and speaks or stays silent.
 *
 * The identity fields exist because these rules have a second reader: the policy
 * engine's built-in catalogue (GP-200) lists them, and a catalogue entry needs a
 * title and a sentence of description — the lint pass itself only ever needed
 * the id and the severity.
 */
export type LintRuleDefinition = {
  ruleId: string;
  severity: LintSeverity;
  /** Short imperative title, e.g. "No NSG open to the internet". */
  title: string;
  /** One sentence: what the rule looks for, and why it is worth looking. */
  description: string;
  run: (node: GraphNode) => LintNote[];
};

/** A rule body: look at one node and speak or stay silent. */
type LintRule = (node: GraphNode) => LintNote[];

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
  const findings: LintNote[] = [];
  for (const match of code.matchAll(SECRET_ATTR)) {
    const [, attr, value] = match;
    if (value!.includes("${")) continue; // interpolation, not a literal
    findings.push({
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
      message: "Password authentication is enabled on this Linux VM.",
      fixHint: "Use SSH keys: disable_password_authentication = true.",
    },
  ];
};

/** Types where a missing `tags` block is worth a nudge — common, definitely
 * taggable resources only, so the rule cannot cry wolf on an association.
 * Exported because the policy engine's `required-tags` rule (GP-200) judges the
 * same population: one list, so the two rules can never disagree about which
 * resources are supposed to carry tags. */
export const TAGGABLE_TYPES = new Set([
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
  // No source is not "no tags": a plan-flow node carries no HCL (GP-120 attaches
  // it in the docs flow only), and reading its absence as an empty tags block
  // would flag every taggable resource of every pull request.
  const code = node.source?.code;
  if (code === undefined) return [];
  if (/^\s*tags\s*=/m.test(code)) return [];
  return [
    {
      message: "This resource carries no tags.",
      fixHint:
        "Tag at least environment and managed_by so cost and ownership stay traceable.",
    },
  ];
};

/**
 * The rule set, in the order it was written. This array is the registry both
 * readers share: the lint pass below runs it, and the policy engine's built-in
 * catalogue (GP-200) wraps each entry as a `PolicyRule` — so a rule added here
 * is evaluated on a pull request and on the documentation of main without being
 * written twice.
 */
export const LINT_RULES: LintRuleDefinition[] = [
  {
    ruleId: "nsg-open-to-internet",
    severity: "high",
    title: "No security group open to the internet",
    description:
      "A network security group with an inbound Allow rule whose source is the internet — the exposure the `Exposed` badge names.",
    run: nsgOpenToInternet,
  },
  {
    ruleId: "ssh-rdp-open-to-internet",
    severity: "high",
    title: "No SSH/RDP open to the internet",
    description:
      "An inbound Allow rule reaching port 22 or 3389 from any internet source.",
    run: sshRdpOpenToInternet,
  },
  {
    ruleId: "hardcoded-secret",
    severity: "high",
    title: "No hardcoded secrets",
    description:
      "A password, key, token or connection string written into the code as a literal string.",
    run: hardcodedSecret,
  },
  {
    ruleId: "storage-public-blob-access",
    severity: "high",
    title: "No anonymous blob access",
    description:
      "A storage account that allows public (anonymous) access to its blobs.",
    run: storagePublicBlobAccess,
  },
  {
    ruleId: "storage-container-public",
    severity: "high",
    title: "No public storage containers",
    description:
      'A storage container whose access type is "blob" or "container", making it world-readable.',
    run: storageContainerPublic,
  },
  {
    ruleId: "storage-http-allowed",
    severity: "warn",
    title: "Storage requires HTTPS",
    description: "A storage account that accepts plain-HTTP traffic.",
    run: storageHttpAllowed,
  },
  {
    ruleId: "weak-tls",
    severity: "warn",
    title: "TLS 1.2 or newer",
    description: "A resource whose minimum TLS version is 1.0 or 1.1.",
    run: weakTls,
  },
  {
    ruleId: "app-https-only-off",
    severity: "warn",
    title: "Web apps serve HTTPS only",
    description: "An app or function app with https_only explicitly disabled.",
    run: httpsOnlyOff,
  },
  {
    ruleId: "key-vault-public-network",
    severity: "warn",
    title: "Key vaults are private",
    description: "A key vault reachable from public networks.",
    run: keyVaultPublicNetwork,
  },
  {
    ruleId: "sql-public-network",
    severity: "warn",
    title: "Database servers are private",
    description: "A managed database server reachable from public networks.",
    run: sqlPublicNetwork,
  },
  {
    ruleId: "vm-password-auth",
    severity: "warn",
    title: "Linux VMs use SSH keys",
    description: "A Linux virtual machine with password authentication enabled.",
    run: vmPasswordAuth,
  },
  {
    ruleId: "missing-tags",
    severity: "info",
    title: "Resources carry tags",
    description:
      "A commonly-taggable resource declared with no tags at all — ownership and cost stop being traceable.",
    run: missingTags,
  },
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
    for (const rule of LINT_RULES) {
      for (const note of rule.run(node)) {
        findings.push({
          ruleId: rule.ruleId,
          severity: rule.severity,
          terraformAddress: node.id,
          ...note,
        });
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
