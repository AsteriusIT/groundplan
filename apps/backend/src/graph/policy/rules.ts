/**
 * GP-200: the built-in rules that are *not* a port of the studio lint pass.
 *
 * Three of them generalize something the product already computed but only ever
 * showed as a badge — internet exposure and broad-scope privilege — or add a
 * check an organization is expected to have an opinion about (required tags,
 * encryption at rest, resources nothing refers to).
 *
 * Every rule here is a pure function of the graph. Two of them read the node's
 * verbatim HCL (v8, GP-120), which only the documentation producer attaches: on
 * a plan snapshot there is no source to read, so they find nothing rather than
 * guessing — the same posture the lint pass takes about provider defaults.
 */
import type { Graph, GraphNode } from "../graph.js";
import { TAGGABLE_TYPES } from "../hcl-lint.js";
import type { PolicyNote, PolicyRule } from "./types.js";

/** Resource nodes only — a module container is not a thing anybody configured. */
function resources(graph: Graph): GraphNode[] {
  return graph.nodes.filter((n) => n.type !== "module" && !n.annotation_group);
}

/**
 * A broad-scope, high-privilege role assignment (GP-47) — what the `Privileged`
 * badge names, said as a rule so it can be configured, waived and reported on
 * like everything else.
 */
const privilegedRoleAssignment: PolicyRule = {
  id: "privileged-role-assignment",
  title: "No broad-scope privileged grants",
  description:
    "A role assignment granting a high-privilege role (Owner, Contributor, User Access Administrator) at subscription or resource-group scope.",
  defaultSeverity: "error",
  appliesTo: ["terraform"],
  evaluate({ graph }) {
    return resources(graph)
      .filter((n) => n.privileged === true && n.role_assignment)
      .map((n) => ({
        address: n.id,
        message: `"${n.role_assignment!.role}" is granted to ${n.role_assignment!.principal} at ${n.role_assignment!.scope}.`,
        hint: "Grant the narrowest built-in role that works, at the narrowest scope that works.",
      }));
  },
};

/**
 * The `tags = { … }` block's keys, or null when the resource declares no tags
 * at all. Reads the verbatim source: the graph does not carry a resource's tags,
 * and inventing a second HCL parser to get at them would be worse than reading
 * the block we already stored.
 */
function declaredTagKeys(code: string): string[] | null {
  const start = /^\s*tags\s*=\s*\{/m.exec(code);
  if (!start) return null;
  const from = start.index + start[0].length;
  let depth = 1;
  let end = from;
  while (end < code.length && depth > 0) {
    const char = code[end];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    end += 1;
  }
  const body = code.slice(from, depth === 0 ? end - 1 : code.length);
  const keys: string[] = [];
  for (const match of body.matchAll(/^\s*"?([\w.-]+)"?\s*=/gm)) {
    keys.push(match[1]!);
  }
  return keys;
}

/**
 * The tag keys an organization decided every resource must carry. Off until
 * somebody says which keys — a tagging policy with no tags in it is a check that
 * always passes, which is worse than no check at all.
 */
const requiredTags: PolicyRule = {
  id: "required-tags",
  title: "Required tags are present",
  description:
    "Every commonly-taggable resource declares the tag keys your organization requires (configure the list).",
  defaultSeverity: "warning",
  appliesTo: ["terraform"],
  defaultEnabled: false,
  defaultParams: { keys: ["environment", "owner"] },
  evaluate({ graph, params }) {
    const required = readStringList(params["keys"]);
    if (required.length === 0) return [];
    const notes: PolicyNote[] = [];
    for (const node of resources(graph)) {
      if (!TAGGABLE_TYPES.has(node.type)) continue;
      const code = node.source?.code;
      if (code === undefined) continue; // no source to read — no verdict
      const declared = new Set(declaredTagKeys(code) ?? []);
      const missing = required.filter((key) => !declared.has(key));
      if (missing.length === 0) continue;
      notes.push({
        address: node.id,
        message: `Missing required tag${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
        hint: `Add ${missing.join(", ")} to this resource's tags block.`,
      });
    }
    return notes;
  },
};

/** A `string[]` parameter, defensively — configuration is data, not a promise. */
function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v !== "");
}

/**
 * Attributes whose explicit `false` means "the data at rest is not encrypted".
 * Absence is *not* a violation: every one of these providers encrypts at rest by
 * default, so reading a missing attribute as "unencrypted" would flag a whole
 * estate for the crime of accepting the default.
 */
const ENCRYPTION_ATTRS = [
  "infrastructure_encryption_enabled",
  "transparent_data_encryption_enabled",
  "encryption_at_rest_enabled",
  "storage_encrypted",
  "encrypted",
] as const;

const encryptionAtRestDisabled: PolicyRule = {
  id: "encryption-at-rest-disabled",
  title: "Encryption at rest stays on",
  description:
    "A resource that explicitly turns encryption at rest off in the code.",
  defaultSeverity: "error",
  appliesTo: ["terraform"],
  evaluate({ graph }) {
    const notes: PolicyNote[] = [];
    for (const node of resources(graph)) {
      const code = node.source?.code;
      if (code === undefined) continue;
      for (const attr of ENCRYPTION_ATTRS) {
        if (!new RegExp(`^\\s*${attr}\\s*=\\s*false\\s*$`, "m").test(code)) continue;
        notes.push({
          address: node.id,
          message: `${attr} is set to false — this resource's data is stored unencrypted.`,
          hint: `Remove the attribute to keep the provider's encrypted default, or set ${attr} = true.`,
        });
      }
    }
    return notes;
  },
};

/**
 * A resource nothing depends on and that depends on nothing. Not wrong by
 * itself — but it is what a leftover looks like, and on a Kubernetes graph it is
 * how an unmounted ConfigMap or an unused Service shows up. Module containment
 * does not count: being written inside a module is not a relationship.
 */
const orphanResource: PolicyRule = {
  id: "orphan-resource",
  title: "No resources left unconnected",
  description:
    "A resource with no dependency in either direction — often something a refactor left behind.",
  defaultSeverity: "info",
  appliesTo: ["terraform", "kubernetes"],
  evaluate({ graph }) {
    const connected = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.kind !== "depends_on") continue;
      connected.add(edge.from);
      connected.add(edge.to);
    }
    return resources(graph)
      .filter((n) => !connected.has(n.id))
      .map((n) => ({
        address: n.id,
        message: "Nothing depends on this resource and it depends on nothing.",
        hint: "Check it is still needed — and if it is, that the reference that should reach it is not missing.",
      }));
  },
};

/** The rules this module contributes to the catalogue, in catalogue order. */
export const GRAPH_RULES: PolicyRule[] = [
  privilegedRoleAssignment,
  encryptionAtRestDisabled,
  requiredTags,
  orphanResource,
];
