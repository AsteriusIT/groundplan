/**
 * GP-62: the grounding input we hand the model — and the wall between it and
 * the raw plan.
 *
 * The model never sees a plan.json. It sees a Markdown brief rendered *from our
 * own deterministic outputs* (the GP-36 summary, graph stats, the flags our
 * rules already derived, human context and annotations). That keeps the prose
 * accountable to something we can re-derive and test, and keeps provider input
 * free of whatever incidental secrets a plan might carry.
 *
 * Every builder here is a pure function — graph in, Markdown out — so the exact
 * bytes we send are golden-testable without a model in the loop.
 */
import type { AnnotationRow, RepositoryRow } from "../db/schema.js";
import { categorize, CATEGORY_LABEL } from "../graph/categories.js";
import type { Graph, GraphNode } from "../graph/graph.js";

/** The human-written context (GP-60) around a repository and its project. */
export type ContextInput = {
  projectName: string;
  projectContextMd: string | null;
  repoContextMd: string | null;
};

/** A titled section, omitted entirely when it has no body. */
export function section(title: string, body: string | null | undefined): string[] {
  const trimmed = body?.trim();
  if (!trimmed) return [];
  return [`## ${title}`, trimmed];
}

/** Project & repository context, quoted as authoritative human knowledge. */
export function contextSection(ctx: ContextInput): string[] {
  return [
    ...section(`Project context (${ctx.projectName})`, ctx.projectContextMd),
    ...section("Repository context", ctx.repoContextMd),
  ];
}

const isResource = (n: GraphNode): boolean => n.type !== "module";

const byId = (a: GraphNode, b: GraphNode): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * `- Compute: 2 created, 1 deleted` — the change set counted by category, so
 * the model can talk about *what kind of thing* moved without us feeding it a
 * per-resource list it would only parrot back.
 */
export function categoryStatsSection(nodes: GraphNode[]): string[] {
  type Counts = { create: number; update: number; delete: number };
  const byCategory = new Map<string, Counts>();

  for (const node of nodes) {
    if (!isResource(node)) continue;
    if (node.change !== "create" && node.change !== "update" && node.change !== "delete") {
      continue;
    }
    const label = CATEGORY_LABEL[categorize(node.type)];
    const counts = byCategory.get(label) ?? { create: 0, update: 0, delete: 0 };
    counts[node.change] += 1;
    byCategory.set(label, counts);
  }
  if (byCategory.size === 0) return [];

  const lines = [...byCategory.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([label, counts]) => {
      const parts: string[] = [];
      if (counts.create > 0) parts.push(`${counts.create} created`);
      if (counts.update > 0) parts.push(`${counts.update} updated`);
      if (counts.delete > 0) parts.push(`${counts.delete} deleted`);
      return `- ${label}: ${parts.join(", ")}`;
    });

  const impacted = nodes.filter((n) => n.impacted === true).length;
  if (impacted > 0) {
    const subject =
      impacted === 1 ? "1 unchanged resource depends" : `${impacted} unchanged resources depend`;
    lines.push(`- Blast radius: ${subject} on something that changed`);
  }
  return ["## Change by category", ...lines];
}

/**
 * The two flags our rules already derived that a reviewer must not miss:
 * internet exposure (GP-43) and privileged IAM grants (GP-47). We give the
 * model the flagged resources *and* whether each one is part of this change,
 * so it can lead with new risk rather than re-litigating what was already true.
 */
export function riskSection(nodes: GraphNode[]): string[] {
  const exposed = nodes.filter((n) => n.internet_exposed === true).sort(byId);
  const privileged = nodes.filter((n) => n.privileged === true).sort(byId);
  if (exposed.length === 0 && privileged.length === 0) return [];

  function state(n: GraphNode): string {
    if (n.change === "create") return "created in this change";
    if (n.change === "update") return "updated in this change";
    if (n.change === "delete") return "deleted in this change";
    if (n.impacted === true) return "unchanged, but impacted by this change";
    return "pre-existing, untouched by this change";
  }

  const lines: string[] = [];
  for (const node of exposed) {
    lines.push(`- Internet-exposed: \`${node.id}\` (${state(node)})`);
  }
  for (const node of privileged) {
    const role = node.role_assignment;
    const grant = role ? ` — grants \`${role.role}\` to \`${role.principal}\` on \`${role.scope}\`` : "";
    lines.push(`- Privileged IAM grant: \`${node.id}\` (${state(node)})${grant}`);
  }
  return ["## Security flags in play", ...lines];
}

export type PrSummaryInput = {
  prNumber: number | null;
  /** The deterministic GP-36 change summary. */
  summaryMd: string;
  graph: Graph;
  context: ContextInput;
};

/**
 * The reviewer's brief for a plan snapshot (GP-63): what our rules already
 * concluded about this change, plus whatever the humans wrote down about the
 * system it lands in. Everything here is derived — nothing is the raw plan.
 */
export function buildPrSummaryInput(input: PrSummaryInput): string {
  const nodes = input.graph.nodes;
  const heading =
    input.prNumber === null
      ? "# Infrastructure change"
      : `# Infrastructure change (PR #${input.prNumber})`;

  const blocks: string[][] = [
    [heading],
    section("Deterministic change summary", input.summaryMd),
    categoryStatsSection(nodes),
    riskSection(nodes),
    contextSection(input.context),
  ];
  return blocks
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}

export type DocsExplainInput = {
  repo: Pick<RepositoryRow, "url" | "defaultBranch">;
  graph: Graph;
  context: ContextInput;
  /** The resolved human annotation layer (GP-57) — notes, links, groups. */
  annotations: AnnotationRow[];
};

/**
 * The newcomer's brief for a docs snapshot. GP-65 enriches this with the module
 * list, network containment and the exposure/privilege flags.
 */
export function buildDocsExplainInput(input: DocsExplainInput): string {
  const resources = input.graph.nodes.filter((n) => n.type !== "module");
  const blocks: string[][] = [
    ["# Infrastructure documentation"],
    [
      "## Repository",
      `- Source: \`${input.repo.url}\` (branch \`${input.repo.defaultBranch}\`)`,
      `- Resources: ${resources.length}`,
    ],
    contextSection(input.context),
    annotationSection(input.annotations),
  ];
  return blocks
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}

/**
 * The annotation layer, quoted as authoritative: these are things a human knew
 * and wrote down that the Terraform itself cannot tell us.
 */
export function annotationSection(rows: AnnotationRow[]): string[] {
  if (rows.length === 0) return [];

  const lines = rows.map((row) => {
    const anchors = row.anchors.map((a) => `\`${a}\``).join(", ");
    const label = row.label ? ` — ${row.label}` : "";
    const body = row.body ? `: ${row.body.replace(/\s+/g, " ").trim()}` : "";
    return `- [${row.type}] ${anchors}${label}${body}`;
  });

  return ["## Human annotations (authoritative)", ...lines];
}
