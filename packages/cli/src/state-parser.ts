/**
 * Producer D (GP-208): a Terraform state file → a graph of what actually exists.
 *
 * **This runs on your machine, and only on your machine.** A state file is the
 * single most sensitive artefact Terraform produces — every database password,
 * every generated key, every certificate your configuration touched is in there
 * in the clear. So the parsing and the sanitising happen in the CLI, before
 * anything is sent, and the server receives a derived graph it could not
 * reconstruct a secret from. The raw state never leaves your environment. The
 * server refuses one if you try (see {@link isRawState}).
 *
 * It lives inside the CLI rather than in a shared workspace package on purpose:
 * `@asteriusit/cli` is published with **zero runtime dependencies**, and the
 * guarantee above is easier to trust when the code that makes it is a single
 * dependency-free file you can read end to end. The graph it emits is checked at
 * the boundary by the server's own JSON-Schema validator, which stays the one
 * authority on the format — this file proposes, the schema decides.
 *
 * ## What is kept
 *
 * Node identity (address, type, name, provider, module path), the dependency
 * edges the state records, module containment — and a **scalar-only** attribute
 * bag. Three filters run over every attribute, in this order:
 *
 *  1. Anything Terraform itself flagged in `sensitive_attributes` is dropped.
 *  2. Anything whose name looks like a secret is dropped, whether Terraform
 *     flagged it or not — providers are inconsistent about marking, and a
 *     defensive list costs nothing.
 *  3. Anything that is not a string, number or boolean is dropped entirely
 *     rather than summarised. This is the rule that does the heavy lifting: a
 *     secret buried at `environment.variables.API_KEY` cannot escape inside a
 *     structure we never serialise. It is the same policy the plan differ
 *     applies to nested values (`{…}`), taken one step further.
 *
 * A residual risk remains and is worth stating plainly: a *scalar* attribute
 * holding a secret that the provider did not mark and whose name looks
 * innocuous would survive. `--dry-run` exists so you can read exactly what would
 * be sent before sending it.
 *
 * ## What is deliberately not derived
 *
 * No network containment, no NSG rules, no role-assignment semantics. Those
 * lenses are derived by the plan and HCL producers, which read a provider schema
 * this file does not have. A reality graph says *what exists and what depends on
 * what* — and says nothing it cannot honestly derive, rather than filling the
 * network lens with a guess.
 */

/** The only state format we read: Terraform ≥ 0.12 and every OpenTofu release. */
const SUPPORTED_VERSION = 4;

/** At most this many attributes are kept per resource. */
const MAX_ATTRS = 40;
/** Scalars longer than this are truncated with a trailing ellipsis. */
const MAX_VALUE_LENGTH = 200;

/**
 * Attribute names that may hold a secret. Substring match, case-insensitive:
 * `master_password`, `client_secret` and `db_connection_string` all hit.
 */
const SECRET_NAME = [
  "password",
  "secret",
  "token",
  "credential",
  "private_key",
  "public_key",
  "ssh_key",
  "key_data",
  "access_key",
  "shared_key",
  "primary_key",
  "secondary_key",
  "api_key",
  "encryption_key",
  "connection_string",
  "sas",
  "certificate",
  "cert_body",
  "salt",
  "session",
  "auth",
];

export type StateNode = {
  id: string;
  name: string;
  type: string;
  provider: string | null;
  module_path: string[];
  change: null;
  attributes?: Record<string, string>;
};

export type StateEdge = {
  from: string;
  to: string;
  kind: "depends_on" | "contains";
};

/**
 * The graph shape the server accepts. Structurally a `GraphSnapshot` — the
 * server validates it against the committed JSON Schema on arrival, so a
 * divergence here fails loudly at the boundary rather than being stored.
 */
export type StateGraph = {
  version: 1 | 7;
  nodes: StateNode[];
  edges: StateEdge[];
};

/** What was derived, and what was withheld — the summary `push-state` prints. */
export type StateParseResult = {
  graph: StateGraph;
  /** Managed resource instances that became nodes. */
  resources: number;
  /** Synthetic module container nodes. */
  modules: number;
  /** Scalar attributes that survived every filter and will be sent. */
  attributes: number;
  /** Attributes dropped because they were sensitive, secret-named or nested. */
  masked: number;
  terraformVersion: string | null;
};

export class UnsupportedStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedStateError";
  }
}

type StateInstance = {
  index_key?: unknown;
  attributes?: unknown;
  sensitive_attributes?: unknown;
  dependencies?: unknown;
};

type StateResource = {
  module?: unknown;
  mode?: unknown;
  type?: unknown;
  name?: unknown;
  provider?: unknown;
  instances?: unknown;
};

/**
 * Does this look like a raw `terraform.tfstate`? Used by the server to refuse
 * one outright — the refusal is the promise, made checkable.
 */
export function isRawState(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["resources"])) return false;
  // A graph snapshot also has a `version`, so the discriminator is the fields
  // only a state has: its identity (`lineage`/`serial`) or the writer's version.
  return (
    "lineage" in v || "serial" in v || "terraform_version" in v || "modules" in v
  );
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `provider["registry.terraform.io/hashicorp/azurerm"]` → `azurerm`. */
function shortProvider(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  const quoted = /"([^"]+)"/.exec(raw);
  const source = quoted?.[1] ?? raw;
  return source.split("/").at(-1) || null;
}

/** Module names from a `module.a.module.b` path, indices stripped. */
function moduleParts(moduleAddress: string): string[] {
  const parts = moduleAddress.split(".");
  const names: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "module") {
      names.push((parts[i + 1] as string).replace(/\[[^\]]*\]$/, ""));
    }
  }
  return names;
}

/** How Terraform writes an instance key in an address: `[0]` or `["blue"]`. */
function indexSuffix(key: unknown): string {
  if (typeof key === "number") return `[${key}]`;
  if (typeof key === "string") return `["${key}"]`;
  return "";
}

/** The attribute paths this instance's provider flagged sensitive. */
function sensitiveKeys(instance: StateInstance): Set<string> {
  const keys = new Set<string>();
  const marks = instance.sensitive_attributes;
  if (!Array.isArray(marks)) return keys;
  for (const path of marks) {
    // A mark is a path: `[{type:"get_attr", value:"shared_key"}, …]`. Its first
    // step names the top-level attribute, which is the granularity we keep — and
    // dropping the whole attribute is the safe reading of a partial mark.
    const first = Array.isArray(path) ? path[0] : undefined;
    const value = (first as { value?: unknown } | undefined)?.value;
    if (typeof value === "string") keys.add(value);
  }
  return keys;
}

function looksSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_NAME.some((needle) => lower.includes(needle));
}

/** A scalar, rendered and bounded; null for anything we refuse to send. */
function scalar(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > MAX_VALUE_LENGTH
      ? `${value.slice(0, MAX_VALUE_LENGTH)}…`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // null, objects and arrays: never serialised. This is the filter a nested
  // secret cannot get past.
  return null;
}

type Sanitised = { attributes: Record<string, string>; kept: number; masked: number };

/** Run the three filters over one instance's attribute bag. */
function sanitise(instance: StateInstance): Sanitised {
  const raw = instance.attributes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { attributes: {}, kept: 0, masked: 0 };
  }
  const sensitive = sensitiveKeys(instance);
  const attributes: Record<string, string> = {};
  let kept = 0;
  let masked = 0;

  for (const key of Object.keys(raw as Record<string, unknown>).sort((a, b) =>
    a.localeCompare(b),
  )) {
    if (sensitive.has(key) || looksSecret(key)) {
      masked += 1;
      continue;
    }
    const rendered = scalar((raw as Record<string, unknown>)[key]);
    if (rendered === null) {
      masked += 1;
      continue;
    }
    if (kept >= MAX_ATTRS) {
      masked += 1;
      continue;
    }
    attributes[key] = rendered;
    kept += 1;
  }

  return { attributes, kept, masked };
}

/** The chain of synthetic module nodes a `module.a.module.b` path implies. */
function moduleChain(moduleAddress: string): StateNode[] {
  const parts = moduleAddress.split(".");
  const chain: StateNode[] = [];
  const idParts: string[] = [];
  const path: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== "module") continue;
    const segment = parts[i + 1] as string;
    idParts.push("module", segment);
    const name = segment.replace(/\[[^\]]*\]$/, "");
    chain.push({
      id: idParts.join("."),
      name,
      type: "module",
      provider: null,
      module_path: [...path],
      change: null,
    });
    path.push(name);
  }
  return chain;
}

/**
 * Read a state file into a sanitised graph. Throws `UnsupportedStateError` when
 * the payload is not a state, or is a state format we do not read.
 */
export function parseState(state: unknown): StateParseResult {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new UnsupportedStateError(
      "this file is not a Terraform state — produce one with `terraform state pull > terraform.tfstate`",
    );
  }
  const doc = state as Record<string, unknown>;
  const version = doc["version"];
  if (version !== SUPPORTED_VERSION) {
    if (typeof version === "number") {
      throw new UnsupportedStateError(
        `this is a version ${version} state; Groundplan reads version ${SUPPORTED_VERSION}, which every Terraform since 0.12 and every OpenTofu writes. Run \`terraform state pull\` with a current CLI to upgrade it.`,
      );
    }
    throw new UnsupportedStateError(
      "this file is not a Terraform state — produce one with `terraform state pull > terraform.tfstate`",
    );
  }
  if (!Array.isArray(doc["resources"])) {
    throw new UnsupportedStateError(
      "this state has no `resources` array — it may be truncated or partially written",
    );
  }

  const nodesById = new Map<string, StateNode>();
  const containsEdges = new Map<string, StateEdge>();
  /** address → the ids of its instances, for resolving bare dependencies. */
  const instancesByBase = new Map<string, string[]>();
  /** node id → the addresses its state entry says it depends on. */
  const dependsOn = new Map<string, string[]>();

  let resources = 0;
  let attributes = 0;
  let masked = 0;

  for (const item of doc["resources"]) {
    const resource = item as StateResource;
    // A data source is a read of something somebody else manages: it is not part
    // of this estate, and putting it on a picture of what exists would overstate
    // what the state actually claims.
    if (resource.mode !== "managed") continue;

    const type = asString(resource.type);
    const name = asString(resource.name);
    const moduleAddress = asString(resource.module);
    const base = [moduleAddress, `${type}.${name}`].filter(Boolean).join(".");
    const provider = shortProvider(resource.provider);
    const modulePath = moduleAddress ? moduleParts(moduleAddress) : [];
    const instances = Array.isArray(resource.instances) ? resource.instances : [];

    const siblings: string[] = [];
    for (const raw of instances) {
      const instance = raw as StateInstance;
      const id = base + indexSuffix(instance.index_key);
      const clean = sanitise(instance);
      attributes += clean.kept;
      masked += clean.masked;

      nodesById.set(id, {
        id,
        name,
        type,
        provider,
        module_path: modulePath,
        change: null,
        ...(clean.kept > 0 ? { attributes: clean.attributes } : {}),
      });
      siblings.push(id);
      resources += 1;

      const deps = Array.isArray(instance.dependencies)
        ? instance.dependencies.filter((d): d is string => typeof d === "string")
        : [];
      if (deps.length > 0) dependsOn.set(id, deps);
    }
    if (siblings.length > 0) instancesByBase.set(base, siblings);

    // Module containers, and the chain down to this resource.
    if (moduleAddress) {
      const chain = moduleChain(moduleAddress);
      for (let i = 0; i < chain.length; i++) {
        const node = chain[i] as StateNode;
        if (!nodesById.has(node.id)) nodesById.set(node.id, node);
        const parent = chain[i - 1];
        if (parent) {
          containsEdges.set(`${parent.id} ${node.id}`, {
            from: parent.id,
            to: node.id,
            kind: "contains",
          });
        }
      }
      const deepest = chain.at(-1);
      if (deepest) {
        for (const id of siblings) {
          containsEdges.set(`${deepest.id} ${id}`, {
            from: deepest.id,
            to: id,
            kind: "contains",
          });
        }
      }
    }
  }

  // Dependencies name bare addresses; an indexed resource has none, so a
  // reference to it reaches every instance — the rule the plan producer follows.
  const dependsEdges: StateEdge[] = [];
  for (const [from, deps] of dependsOn) {
    for (const dep of deps) {
      const targets = nodesById.has(dep) ? [dep] : (instancesByBase.get(dep) ?? []);
      for (const to of targets) {
        if (to !== from) dependsEdges.push({ from, to, kind: "depends_on" });
      }
    }
  }

  const nodes = [...nodesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...containsEdges.values(), ...dependsEdges].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to),
  );

  return {
    graph: {
      // v7 is the schema version that allows a node's flattened `attributes`;
      // without any, the graph is a plain v1 and stays byte-identical to one.
      version: nodes.some((n) => n.attributes !== undefined) ? 7 : 1,
      nodes,
      edges,
    },
    resources,
    modules: nodes.filter((n) => n.type === "module").length,
    attributes,
    masked,
    terraformVersion:
      typeof doc["terraform_version"] === "string" ? doc["terraform_version"] : null,
  };
}
