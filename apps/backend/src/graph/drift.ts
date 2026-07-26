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
import { isTerraformPlan } from "./plan-parser.js";

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
