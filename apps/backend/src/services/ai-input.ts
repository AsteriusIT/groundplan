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
import { categorize, CATEGORY_LABEL, shortType } from "../graph/categories.js";
import type { Graph, GraphNode } from "../graph/graph.js";
import { changesSubgraph } from "../graph/subgraph.js";

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

/** `- Compute: 4 (linux_virtual_machine ×3, kubernetes_cluster)` — the inventory. */
export function inventorySection(nodes: GraphNode[]): string[] {
  const byCategory = new Map<string, Map<string, number>>();

  for (const node of nodes) {
    if (!isResource(node)) continue;
    const label = CATEGORY_LABEL[categorize(node.type)];
    const types = byCategory.get(label) ?? new Map<string, number>();
    const short = shortType(node.type);
    types.set(short, (types.get(short) ?? 0) + 1);
    byCategory.set(label, types);
  }
  if (byCategory.size === 0) return [];

  const rows = [...byCategory.entries()].map(([label, types]) => {
    const total = [...types.values()].reduce((sum, k) => sum + k, 0);
    const parts = [...types.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([type, k]) => (k > 1 ? `${type} ×${k}` : type));
    return { total, label, line: `- ${label}: ${total} (${parts.join(", ")})` };
  });

  rows.sort((a, b) => b.total - a.total || (a.label < b.label ? -1 : 1));
  return ["## What is in here (by category)", ...rows.map((r) => r.line)];
}

/** The Terraform modules the system is decomposed into — its authored structure. */
export function moduleSection(nodes: GraphNode[]): string[] {
  const modules = nodes
    .filter((n) => n.type === "module")
    .map((n) => n.id)
    .sort((a, b) => (a < b ? -1 : 1));
  if (modules.length === 0) return [];
  return ["## Modules", ...modules.map((m) => `- \`${m}\``)];
}

/**
 * The network shape (GP-42): what sits inside what. This is the single most
 * useful thing for "how do these blocks talk to each other" — a flat resource
 * list can't say that a VM is inside a subnet inside a vnet.
 */
export function containmentSection(nodes: GraphNode[]): string[] {
  const childrenOf = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    const siblings = childrenOf.get(node.parent_id) ?? [];
    siblings.push(node);
    childrenOf.set(node.parent_id, siblings);
  }
  if (childrenOf.size === 0) return [];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Roots: containers that are not themselves contained (a vnet, typically).
  const roots = [...childrenOf.keys()]
    .filter((id) => !byId.get(id)?.parent_id)
    .sort((a, b) => (a < b ? -1 : 1));

  const lines: string[] = [];
  const walk = (id: string, depth: number): void => {
    const kids = (childrenOf.get(id) ?? [])
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const kid of kids) {
      const grandkids = childrenOf.get(kid.id);
      const count = grandkids
        ? ` — contains ${grandkids.length} ${grandkids.length === 1 ? "resource" : "resources"}`
        : "";
      lines.push(`${"  ".repeat(depth)}- \`${kid.id}\`${count}`);
      // Two levels of nesting (vnet ⊃ subnet) is the shape; below that we
      // summarise with the count above rather than listing every VM.
      if (depth < 1) walk(kid.id, depth + 1);
    }
  };

  for (const root of roots) {
    lines.push(`- \`${root}\``);
    walk(root, 1);
  }
  return ["## Network containment (what sits inside what)", ...lines];
}

/** Standing exposure and privilege in the system as documented (not a change). */
export function standingRiskSection(nodes: GraphNode[]): string[] {
  const exposed = nodes.filter((n) => n.internet_exposed === true).sort(byId);
  const privileged = nodes.filter((n) => n.privileged === true).sort(byId);
  if (exposed.length === 0 && privileged.length === 0) return [];

  const lines: string[] = [];
  for (const node of exposed) {
    const attached = node.associated_ids?.length
      ? ` — attached to ${node.associated_ids.map((a) => `\`${a}\``).join(", ")}`
      : "";
    lines.push(`- Reachable from the internet: \`${node.id}\`${attached}`);
  }
  for (const node of privileged) {
    const role = node.role_assignment;
    const grant = role
      ? ` — grants \`${role.role}\` to \`${role.principal}\` on \`${role.scope}\``
      : "";
    lines.push(`- Privileged IAM grant: \`${node.id}\`${grant}`);
  }
  return ["## Points of attention (derived by rules, not opinion)", ...lines];
}

export type DocsExplainInput = {
  repo: Pick<RepositoryRow, "url" | "defaultBranch">;
  graph: Graph;
  context: ContextInput;
  /** The resolved human annotation layer (GP-57) — notes, links, groups. */
  annotations: AnnotationRow[];
};

/**
 * The newcomer's brief for a docs snapshot (GP-65): the inventory, the authored
 * structure, the network shape, the standing risks — and, crucially, whatever
 * the humans wrote down, which is the only part Terraform cannot tell us.
 */
export function buildDocsExplainInput(input: DocsExplainInput): string {
  const nodes = input.graph.nodes;
  const resources = nodes.filter(isResource);

  const blocks: string[][] = [
    ["# Infrastructure documentation"],
    [
      "## Repository",
      `- Source: \`${input.repo.url}\` (branch \`${input.repo.defaultBranch}\`)`,
      `- Resources: ${resources.length}`,
    ],
    inventorySection(nodes),
    moduleSection(nodes),
    containmentSection(nodes),
    standingRiskSection(nodes),
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

export type ProposalInput = {
  repo: Pick<RepositoryRow, "url" | "defaultBranch">;
  graph: Graph;
  context: ContextInput;
  /** Annotations that already exist, so the model does not re-propose them. */
  annotations: AnnotationRow[];
};

/**
 * The brief for the annotation proposer (GP-75).
 *
 * Unlike the prose briefs, this one has to name every anchorable thing exactly:
 * the model's output is a set of Terraform *addresses*, and an address it did not
 * see verbatim is an address it invented. So the resource table is the heart of
 * this input — address, type, category, module — and the existing annotations are
 * included so it proposes what is missing rather than what is already there.
 */
export function buildProposalInput(input: ProposalInput): string {
  const nodes = input.graph.nodes;
  const resources = nodes.filter(isResource);

  const table = [
    "## Resources (anchor to these addresses, exactly as written)",
    "| address | type | category | module |",
    "| --- | --- | --- | --- |",
    ...resources
      .map((n) => {
        const module = n.module_path.length > 0 ? n.module_path.join(".") : "root";
        const category = CATEGORY_LABEL[categorize(n.type)];
        return `| \`${n.id}\` | ${n.type} | ${category} | ${module} |`;
      })
      .sort((a, b) => (a < b ? -1 : 1)),
  ];

  const blocks: string[][] = [
    ["# Infrastructure to organise"],
    [
      "## Repository",
      `- Source: \`${input.repo.url}\` (branch \`${input.repo.defaultBranch}\`)`,
      `- Resources: ${resources.length}`,
    ],
    table,
    containmentSection(nodes),
    dependencySection(input.graph),
    contextSection(input.context),
    existingAnnotationSection(input.annotations),
  ];
  return blocks
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}

/**
 * Who depends on whom. Grouping is mostly a question about coupling, and the
 * dependency edges are the only evidence of it we have that is not a guess.
 */
export function dependencySection(graph: Graph): string[] {
  const edges = graph.edges
    .filter((e) => e.kind === "depends_on")
    .map((e) => `- \`${e.from}\` → \`${e.to}\``)
    .sort((a, b) => (a < b ? -1 : 1));
  if (edges.length === 0) return [];
  return ["## Dependencies (dependent → dependency)", ...edges];
}

/**
 * What is already annotated — so the proposer adds to the picture instead of
 * arguing with it. Proposals still awaiting review are included: a suggestion
 * nobody has answered yet should not be made twice.
 */
export function existingAnnotationSection(rows: AnnotationRow[]): string[] {
  if (rows.length === 0) return [];
  const lines = rows.map((row) => {
    const anchors = row.anchors.map((a) => `\`${a}\``).join(", ");
    const label = row.label ? ` — ${row.label}` : "";
    return `- [${row.type}, ${row.status}] ${anchors}${label}`;
  });
  return [
    "## Annotations that already exist (do not repeat these)",
    ...lines,
  ];
}

/** Where a node stands in the change — the column a tour stop is really about. */
function changeState(node: GraphNode): string {
  if (node.change === "create") return "created";
  if (node.change === "update") return "updated";
  if (node.change === "delete") return "deleted";
  if (node.impacted === true) return "impacted (unchanged, depends on a change)";
  return "unchanged";
}

export type ChangeTourInput = {
  prNumber: number | null;
  /** The deterministic GP-36 change summary. */
  summaryMd: string;
  graph: Graph;
  context: ContextInput;
};

/**
 * The brief for a change tour (GP-78).
 *
 * Like the proposer's, this brief must name every anchorable thing exactly — a
 * tour stop is a set of node ids, and an id the model never saw is a stop the
 * player cannot fly to. Unlike the proposer's, the anchorable set is *not* the
 * whole estate: a tour of a pull request stops in the neighbourhood of the change,
 * so we hand it `changesSubgraph` — the changed and impacted nodes, their one-hop
 * dependencies and the modules that hold them. That is both what a tour should
 * visit and, conveniently, a brief that stays small on a large estate.
 */
export function buildChangeTourInput(input: ChangeTourInput): string {
  const scope = changesSubgraph(input.graph);
  const heading =
    input.prNumber === null
      ? "# Infrastructure change to tour"
      : `# Infrastructure change to tour (PR #${input.prNumber})`;

  const table = [
    "## Stops you may anchor to (use these ids, exactly as written)",
    "| id | type | in this change | module |",
    "| --- | --- | --- | --- |",
    ...scope.nodes
      .map((n) => {
        const module = n.module_path.length > 0 ? n.module_path.join(".") : "root";
        const kind = n.type === "module" ? "module (a container)" : n.type;
        return `| \`${n.id}\` | ${kind} | ${changeState(n)} | ${module} |`;
      })
      .sort((a, b) => (a < b ? -1 : 1)),
  ];

  const blocks: string[][] = [
    [heading],
    section("Deterministic change summary", input.summaryMd),
    categoryStatsSection(input.graph.nodes),
    riskSection(input.graph.nodes),
    table,
    containmentSection(scope.nodes),
    dependencySection(scope),
    contextSection(input.context),
  ];
  return blocks
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}

export type SystemTourInput = {
  repo: Pick<RepositoryRow, "url" | "defaultBranch">;
  /**
   * The graph the tour will *play against* — the adapted projection when the repo
   * has groups, so the model can stop at "the storefront" rather than at seven
   * addresses. Anchors are validated against this same graph.
   */
  graph: Graph;
  context: ContextInput;
  annotations: AnnotationRow[];
};

/**
 * The brief for a system tour (GP-78) — the docs-page counterpart.
 *
 * The graph here may be the adapted projection, so the anchor table lists three
 * kinds of stop: a group the team named, a Terraform module, or a single resource.
 * They are separated in the table because they are not equivalent — a tour that
 * stops at a group is showing someone a *system*, which is the whole point, and
 * one that stops at a resource is showing them a detail.
 */
export function buildSystemTourInput(input: SystemTourInput): string {
  const nodes = input.graph.nodes;
  // A group container synthesised from a `group` annotation (GP-72), not a
  // Terraform module and not a resource.
  const groups = nodes.filter((n) => n.annotation_group === true);
  const modules = nodes.filter((n) => n.type === "module");
  const resources = nodes.filter(
    (n) => n.type !== "module" && n.annotation_group !== true,
  );

  const memberOf = new Map<string, number>();
  for (const edge of input.graph.edges) {
    if (edge.kind !== "contains") continue;
    memberOf.set(edge.from, (memberOf.get(edge.from) ?? 0) + 1);
  }

  const table = [
    "## Stops you may anchor to (use these ids, exactly as written)",
    "| id | what it is | holds |",
    "| --- | --- | --- |",
    ...groups.map((n) => {
      const members = n.member_count ?? memberOf.get(n.id) ?? 0;
      const label = n.display_label ?? n.name;
      return `| \`${n.id}\` | group the team named: "${label}" | ${members} resources |`;
    }),
    ...modules
      .map((n) => `| \`${n.id}\` | Terraform module | ${memberOf.get(n.id) ?? 0} resources |`)
      .sort((a, b) => (a < b ? -1 : 1)),
    ...resources
      .map((n) => {
        const category = CATEGORY_LABEL[categorize(n.type)];
        const label = n.display_label ? ` (the team calls it "${n.display_label}")` : "";
        return `| \`${n.id}\` | ${n.type} — ${category}${label} | |`;
      })
      .sort((a, b) => (a < b ? -1 : 1)),
  ];

  const blocks: string[][] = [
    ["# Infrastructure to tour"],
    [
      "## Repository",
      `- Source: \`${input.repo.url}\` (branch \`${input.repo.defaultBranch}\`)`,
      `- Resources: ${resources.length}`,
    ],
    table,
    inventorySection(resources),
    containmentSection(nodes),
    dependencySection(input.graph),
    standingRiskSection(nodes),
    contextSection(input.context),
    annotationSection(input.annotations),
  ];
  return blocks
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}
