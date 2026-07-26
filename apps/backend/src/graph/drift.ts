/**
 * GP-206: what changed under Terraform's feet.
 *
 * A `terraform plan -refresh-only` is a plan.json like any other — which is the
 * whole point of the first volet of GP-205: reconciling code with reality costs
 * us no new parser and, more importantly, no cloud credentials. The user's own
 * pipeline runs the refresh with the access it already has; we read the artefact
 * it produced, exactly as we read a pull request's plan instead of running
 * `terraform` ourselves.
 *
 * Two things make this file more than a rename of the plan parser:
 *
 *  1. **Drift lives in `resource_drift`, not `resource_changes`.** Terraform
 *     puts what it *found* in one array and what it *would do* in the other. A
 *     refresh-only plan has the first and an empty second, and reading the wrong
 *     one would report the code's intentions as the world's state.
 *  2. **A plan that plans something is refused.** If `resource_changes` holds an
 *     action, the artefact came from a normal `terraform plan` — it measures
 *     what the code wants, not what the cloud did. Storing it as drift would
 *     mean showing a reviewer their own pull request and calling it reality, so
 *     the ingestion says no, loudly, at the point of failure.
 *
 * Pure, like the parsers and the policy engine: plan in, report out. No clock,
 * no I/O, and the same plan yields the same report byte for byte.
 */
import {
  computeAttributeDiff,
  type AttributeDiffRow,
  type PlanResourceChange,
} from "./attribute-diff.js";
import type { Graph, GraphNode } from "./graph.js";
import { isTerraformPlan, parsePlanToGraph } from "./plan-parser.js";
import type { PolicyDelta } from "./policy/diff.js";

/**
 * What reality did to a resource. There is deliberately no `create`: a resource
 * created outside Terraform is not in the state, so a refresh cannot see it —
 * finding those is the reality snapshot's job (GP-208/GP-209), and pretending
 * this producer could answer it would be a hole shaped like a feature.
 */
export type DriftChange = "update" | "delete";

/** One resource the world changed without the code being asked. */
export type DriftedResource = {
  /** Terraform address — the same anchor a violation and an annotation use. */
  address: string;
  type: string;
  /** Short provider name (`azurerm`); null when the plan did not name one. */
  provider: string | null;
  /** Module names from the root down to this resource's module. */
  module_path: string[];
  change: DriftChange;
  /** Masked before→after rows, from the same differ the pull-request view uses. */
  attribute_diff: AttributeDiffRow[];
  /** True when the changed-attribute list exceeded the cap and was capped. */
  attribute_diff_truncated?: boolean;
};

export type DriftCounts = {
  updated: number;
  deleted: number;
  total: number;
};

/**
 * One measurement of an estate against its code.
 *
 * Versioned in place like the graph and the policy report: a new optional field
 * bumps the version only when it is populated, so a stored report stays
 * byte-identical and every consumer must handle any version.
 *
 * v1 = the drifted resources. v2 (GP-207) adds `policy`: what the drift does to
 * the estate's compliance.
 */
export type DriftReport = {
  version: 1 | 2;
  counts: DriftCounts;
  resources: DriftedResource[];
  /**
   * v2 (GP-207): what the drift does to compliance, as a comparison between the
   * estate as it *is* and the estate as the code *describes it*.
   *
   * It is a `PolicyDelta` — the same shape and the same comparison a pull request
   * gets (GP-202) — read with reality as the head and the code as the base. So
   * `added` means **a violation that exists in the cloud but not in the code**:
   * something introduced outside IaC, which is the signal a security reader came
   * for. `resolved` is the mirror image: a violation the code has that somebody
   * already fixed by hand, which is its own kind of problem.
   *
   * Absent when there was no comparable verdict of the code to compare against
   * (main has no diagram at the measured sha). Absent, never empty: "nothing was
   * introduced outside IaC" and "nobody could check" are different answers.
   */
  policy?: PolicyDelta;
};

/** Thrown when a payload is not a refresh-only plan. Carries the reason shown. */
export class NotRefreshOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotRefreshOnlyError";
  }
}

type DriftEntry = {
  address?: unknown;
  module_address?: unknown;
  mode?: unknown;
  type?: unknown;
  name?: unknown;
  provider_name?: unknown;
  change?: PlanResourceChange & { actions?: unknown };
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Normalize a provider name ("registry.terraform.io/hashicorp/azurerm" → "azurerm"). */
function shortProvider(providerName: unknown): string | null {
  if (typeof providerName !== "string" || providerName === "") return null;
  return providerName.split("/").at(-1) || null;
}

/** Module names from a `module_address` ("module.a.module.b" → ["a","b"]). */
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

function actionsOf(entry: DriftEntry): string[] {
  const actions = entry.change?.actions;
  return Array.isArray(actions)
    ? actions.filter((a): a is string => typeof a === "string")
    : [];
}

/** Actions that mean the code wants to change a remote object. */
const PLANNED_ACTIONS = new Set(["create", "update", "delete"]);

/**
 * Why this payload cannot be read as drift, or null when it can.
 *
 * The rule is one sentence: **a refresh-only plan plans nothing**. Terraform
 * says so itself ("this is a refresh-only plan, so Terraform will not take any
 * actions"), so any create/update/delete in `resource_changes` proves the
 * artefact came from a normal plan. `no-op` and `read` entries are what a
 * refresh-only plan does contain, and they are fine.
 */
export function refreshOnlyRejection(plan: unknown): string | null {
  if (!isTerraformPlan(plan)) {
    return "this does not look like a Terraform plan (no format_version / resource_changes) — produce it with `terraform plan -refresh-only -out=tfplan && terraform show -json tfplan`";
  }
  const changes = (plan as { resource_changes: unknown[] }).resource_changes;
  const planned = new Set<string>();
  for (const raw of changes) {
    for (const action of actionsOf(raw as DriftEntry)) {
      if (PLANNED_ACTIONS.has(action)) planned.add(action);
    }
  }
  if (planned.size === 0) return null;
  const listed = [...planned].sort((a, b) => a.localeCompare(b)).join(", ");
  return `this plan proposes changes (${listed}) — it is a normal plan, not a measurement of the estate. Drift is measured with \`terraform plan -refresh-only\`, which plans nothing and reports only what changed outside Terraform.`;
}

/**
 * Read a refresh-only plan into a drift report.
 *
 * Throws `NotRefreshOnlyError` when the payload plans anything — see
 * {@link refreshOnlyRejection}. A plan with no drift at all is *not* an error:
 * "nothing has drifted" is the answer people run this to get, and it has to be
 * storable so the banner can say when it was last true.
 */
export function parseDriftPlan(plan: unknown): DriftReport {
  const rejection = refreshOnlyRejection(plan);
  if (rejection) throw new NotRefreshOnlyError(rejection);

  const raw = (plan as { resource_drift?: unknown }).resource_drift;
  const entries = Array.isArray(raw) ? raw : [];

  const resources: DriftedResource[] = [];
  for (const item of entries) {
    const entry = item as DriftEntry;
    // Data sources are read on every run and manage nothing — a value that
    // moved in one is news about the provider, not about our estate.
    if (entry.mode === "data") continue;

    const actions = actionsOf(entry);
    const change: DriftChange = actions.includes("delete") ? "delete" : "update";
    const { rows, truncated } = computeAttributeDiff(entry.change, change);
    const moduleAddress = asString(entry.module_address);

    resources.push({
      address: asString(entry.address),
      type: asString(entry.type),
      provider: shortProvider(entry.provider_name),
      module_path: moduleAddress ? moduleParts(moduleAddress) : [],
      change,
      attribute_diff: rows,
      ...(truncated ? { attribute_diff_truncated: true } : {}),
    });
  }

  resources.sort((a, b) => a.address.localeCompare(b.address));

  const counts: DriftCounts = {
    updated: resources.filter((r) => r.change === "update").length,
    deleted: resources.filter((r) => r.change === "delete").length,
    total: resources.length,
  };

  return { version: 1, counts, resources };
}

/**
 * The node fields that describe **the world**, as opposed to the code.
 *
 * This split is the whole idea behind the reality graph. A refresh tells us what
 * a resource *is* right now — its security rules, whether it ended up
 * internet-exposed, what identity it carries — and nothing whatsoever about the
 * repository. So these fields are taken from the refresh and everything else,
 * `source` above all, is left exactly as the code parse produced it: a change in
 * the portal cannot edit somebody's `.tf` file, and a rule that reads the HCL
 * must give the same verdict on both sides.
 *
 * The consequence is the point: the only violations that can appear in reality
 * but not in the code are the ones the *world* introduced.
 */
const WORLD_FIELDS = [
  "rules",
  "internet_exposed",
  "associated_ids",
  "role_assignment",
  "privileged",
  "identity",
  "attributes",
  "attributes_truncated",
  "parent_id",
] as const satisfies readonly (keyof GraphNode)[];

/**
 * The estate as the refresh found it: the graph the code describes, with the
 * resources that drifted carrying what is actually out there.
 *
 * Built by feeding `resource_drift` to Producer A as if it were `resource_changes`
 * — the entries have exactly that shape, and doing so buys every semantic the
 * plan parser already derives (NSG rules and exposure, role-assignment triples
 * and the privileged flag, network containment) with no second parser to keep in
 * step. What comes back is then folded over the code's graph by address.
 *
 * Deliberate limits, each of them the honest answer:
 *  - A drifted address the code's graph does not hold is **skipped**. It is
 *    almost always an instance suffix (`x[0]` against a bare `x`), and inventing
 *    a node for it would put a resource on the diagram nobody wrote.
 *  - A resource deleted outside Terraform is removed, and the edges that only
 *    made sense through it go with it.
 *  - Nothing is added. A resource created outside Terraform is not in the state,
 *    so a refresh cannot see it; that is the reality snapshot's question
 *    (GP-208/GP-209), and answering it from here would be a guess.
 */
export function realityGraph(code: Graph, plan: unknown): Graph {
  const raw = (plan as { resource_drift?: unknown } | null)?.resource_drift;
  const entries = Array.isArray(raw) ? raw : [];
  if (entries.length === 0) return code;

  // Producer A, run over what the refresh found. `configuration` rides along so
  // whatever the plan happened to carry is honoured; nothing here depends on it.
  const observed = parsePlanToGraph({
    format_version: "1.2",
    resource_changes: entries,
    configuration: (plan as { configuration?: unknown }).configuration,
  });
  const observedById = new Map(observed.nodes.map((node) => [node.id, node]));
  const deleted = deletedAddresses(entries);

  const nodes = code.nodes
    .filter((node) => !deleted.has(node.id))
    .map((node) => withWorldOf(node, observedById.get(node.id)));

  const present = new Set(nodes.map((node) => node.id));
  return {
    ...code,
    nodes,
    edges: code.edges.filter((e) => present.has(e.from) && present.has(e.to)),
  };
}

/** The addresses the refresh found are simply not there any more. */
function deletedAddresses(entries: readonly unknown[]): Set<string> {
  const deleted = new Set<string>();
  for (const item of entries) {
    const entry = item as DriftEntry;
    if (entry.mode === "data") continue;
    if (actionsOf(entry).includes("delete")) deleted.add(asString(entry.address));
  }
  return deleted;
}

/** One node, with {@link WORLD_FIELDS} taken from what the refresh observed. */
function withWorldOf(node: GraphNode, world: GraphNode | undefined): GraphNode {
  if (!world) return node;
  const merged: GraphNode = { ...node };
  for (const field of WORLD_FIELDS) {
    if (world[field] === undefined) delete merged[field];
    else Object.assign(merged, { [field]: world[field] });
  }
  return merged;
}

/** How many attribute rows a resource shows in the summary before it stops. */
const SUMMARY_ROWS = 5;
/** How many resources the summary lists before it counts the rest. */
const SUMMARY_RESOURCES = 20;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The drift, as deterministic Markdown (the house rule: same input ⇒ same
 * bytes). It is what the panel's header reads and what a future export prints.
 */
export function summarizeDrift(report: DriftReport): string {
  if (report.counts.total === 0) {
    return "No drift: every resource Terraform manages matches the code.";
  }

  const verb = report.counts.total === 1 ? "has" : "have";
  const headline = `**${plural(report.counts.total, "resource")} ${verb} drifted** — changed outside Terraform.`;
  const breakdown: string[] = [];
  if (report.counts.updated > 0) {
    breakdown.push(`${report.counts.updated} modified`);
  }
  if (report.counts.deleted > 0) {
    breakdown.push(`${report.counts.deleted} deleted outside Terraform`);
  }

  const blocks: string[] = [
    breakdown.length > 0 ? `${headline} (${breakdown.join(", ")})` : headline,
  ];

  for (const resource of report.resources.slice(0, SUMMARY_RESOURCES)) {
    const lines = [
      resource.change === "delete"
        ? `- \`${resource.address}\` — no longer exists`
        : `- \`${resource.address}\``,
    ];
    for (const row of resource.attribute_diff.slice(0, SUMMARY_ROWS)) {
      lines.push(`  - \`${row.key}\`: ${row.before ?? "—"} → ${row.after ?? "—"}`);
    }
    const hidden = resource.attribute_diff.length - SUMMARY_ROWS;
    if (hidden > 0) lines.push(`  - …and ${plural(hidden, "more attribute")}`);
    blocks.push(lines.join("\n"));
  }

  const remaining = report.resources.length - SUMMARY_RESOURCES;
  if (remaining > 0) blocks.push(`…and ${plural(remaining, "more resource")}.`);

  return blocks.join("\n\n");
}
