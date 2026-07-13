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
import type { Graph } from "../graph/graph.js";

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

export type PrSummaryInput = {
  prNumber: number | null;
  /** The deterministic GP-36 change summary. */
  summaryMd: string;
  graph: Graph;
  context: ContextInput;
};

/**
 * The reviewer's brief for a plan snapshot. GP-63 enriches this with change
 * stats by category and the exposure/privilege flags in play.
 */
export function buildPrSummaryInput(input: PrSummaryInput): string {
  const blocks: string[][] = [
    [
      `# Infrastructure change${input.prNumber === null ? "" : ` (PR #${input.prNumber})`}`,
    ],
    section("Deterministic change summary", input.summaryMd),
    contextSection(input.context),
  ];
  return blocks
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n\n"))
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
