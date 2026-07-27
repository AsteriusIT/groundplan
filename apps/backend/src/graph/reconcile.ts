/**
 * GP-209: reality against code — the graph of what exists, compared with the
 * graph of what the repository says should exist.
 *
 * Three findings, and they are the whole point of the view:
 *
 *  - **unmanaged** — in the cloud, absent from the code. Somebody made it by
 *    hand. Nobody reviewed it, nobody can reproduce it, and destroying the
 *    workspace would not remove it.
 *  - **not applied** — in the code, absent from the cloud. The repository
 *    describes something that was never built, or that was deleted underneath it.
 *  - **divergent** — in both, disagreeing on an attribute they both recorded.
 *
 * The mechanism is the graph-vs-graph comparison the Kubernetes flow already
 * uses when there is no plan to ask (`change-diff.ts`), pointed at a different
 * pair of graphs. What it must not borrow is the *vocabulary*: `changesFromBase`
 * answers "what would this pull request do", and every word in its output is
 * about a proposal. Nothing here is proposed. The `change` field is reused
 * because it is what the renderer colours by; every label a human reads is this
 * module's own.
 *
 * Pure, like every other producer: two graphs in, one comparison out, the same
 * bytes every time.
 */
import { changesFromBase } from "./change-diff.js";
import type { Graph, GraphNode } from "./graph.js";

export type ReconcileCounts = {
  /** In the cloud, not in the code. */
  unmanaged: number;
  /** In the code, not in the cloud. */
  notApplied: number;
  /** In both, disagreeing. */
  divergent: number;
  /** In both, agreeing on everything both sides recorded. */
  matching: number;
};

export type Reconciliation = {
  version: 1;
  /** The comparison, coloured for the canvas: create/delete/update/noop. */
  graph: Graph;
  counts: ReconcileCounts;
  /** Addresses, sorted — what the panel lists and what the summary prints. */
  unmanaged: string[];
  notApplied: string[];
  divergent: string[];
};

/** A module container is scaffolding the producers invent, not a resource. */
function isResource(node: GraphNode): boolean {
  return node.type !== "module" && node.annotation_group !== true;
}

/**
 * Attribute rows the two sides genuinely disagree on.
 *
 * Only keys **both** graphs recorded are compared. The two producers keep
 * different bags — the docs parse keeps a subnet's CIDRs, the state parse keeps
 * whatever scalars survived sanitising — so "the code did not record this" is
 * not evidence that the cloud changed it. Reading it as such would mark an
 * entire estate divergent for the crime of being described differently by two
 * parsers, which is a finding about us, not about the user's infrastructure.
 */
function disagreements(
  code: GraphNode,
  reality: GraphNode,
): { key: string; before: string; after: string }[] {
  const before = code.attributes ?? {};
  const after = reality.attributes ?? {};
  const rows: { key: string; before: string; after: string }[] = [];
  for (const key of Object.keys(before).sort((a, b) => a.localeCompare(b))) {
    const mine = before[key];
    const theirs = after[key];
    if (mine === undefined || theirs === undefined) continue;
    if (mine !== theirs) rows.push({ key, before: mine, after: theirs });
  }
  return rows;
}

/** Sort every resource the cloud has into unmanaged, divergent, or agreeing. */
function classifyReality(
  reality: Graph,
  codeById: Map<string, GraphNode>,
): { unmanaged: string[]; divergent: string[]; agreeing: Set<string> } {
  const unmanaged: string[] = [];
  const divergent: string[] = [];
  const agreeing = new Set<string>();

  for (const node of reality.nodes) {
    if (!isResource(node)) continue;
    const declared = codeById.get(node.id);
    if (!declared) {
      unmanaged.push(node.id);
    } else if (disagreements(declared, node).length > 0) {
      divergent.push(node.id);
    } else {
      agreeing.add(node.id);
    }
  }
  return { unmanaged, divergent, agreeing };
}

/**
 * Compare the code's graph with the cloud's.
 *
 * `changesFromBase(code, reality)` does the structural work and the colouring;
 * this function then re-derives the *findings* from the two graphs directly,
 * because the two questions differ on attributes: the change differ calls any
 * asymmetry an update, and here an attribute only one producer recorded is not a
 * disagreement at all. Nodes that turn out to agree are corrected back to
 * `noop`, so the canvas never colours a resource nobody has a finding about.
 */
export function reconcile(code: Graph, reality: Graph): Reconciliation {
  const codeById = new Map(code.nodes.map((n) => [n.id, n]));
  const realityById = new Map(reality.nodes.map((n) => [n.id, n]));
  const { unmanaged, divergent, agreeing } = classifyReality(reality, codeById);
  const notApplied = code.nodes
    .filter((node) => isResource(node) && !realityById.has(node.id))
    .map((node) => node.id);

  const compared = changesFromBase(code, reality);
  const nodes = compared.nodes.map((node) => {
    if (!agreeing.has(node.id)) return node;
    // The differ saw an asymmetric attribute bag and called it an update. The
    // two sides agree on everything they both recorded, so it is a noop — and
    // its diff rows are dropped with it, because there is nothing to show.
    const { attribute_diff: _rows, attribute_diff_truncated: _capped, ...rest } = node;
    return { ...rest, change: "noop" as const };
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const address of divergent) {
    const node = byId.get(address);
    if (!node) continue;
    // Say the disagreement in the two producers' own terms, rather than whatever
    // asymmetry the change differ happened to notice.
    node.change = "update";
    node.attribute_diff = disagreements(
      codeById.get(address) as GraphNode,
      realityById.get(address) as GraphNode,
    );
    // The rows above are the complete disagreement, so any cap the change differ
    // recorded is about a list nobody is looking at any more.
    delete node.attribute_diff_truncated;
  }

  const sort = (list: string[]): string[] =>
    list.toSorted((a, b) => a.localeCompare(b));

  return {
    version: 1,
    graph: { ...compared, nodes },
    counts: {
      unmanaged: unmanaged.length,
      notApplied: notApplied.length,
      divergent: divergent.length,
      matching: agreeing.size,
    },
    unmanaged: sort(unmanaged),
    notApplied: sort(notApplied),
    divergent: sort(divergent),
  };
}

/** How many addresses a section prints before it counts the rest. */
const SECTION_CAP = 20;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function section(title: string, addresses: string[], note: string): string[] {
  if (addresses.length === 0) return [];
  const rows = addresses.slice(0, SECTION_CAP).map((a) => `- \`${a}\``);
  if (addresses.length > SECTION_CAP) {
    rows.push(`…and ${plural(addresses.length - SECTION_CAP, "more")}`);
  }
  return [`**${title}** — ${note}`, ...rows];
}

/**
 * The comparison as deterministic Markdown, in reconciliation words.
 *
 * Every label here is chosen to avoid the plan's vocabulary. "Created" and
 * "destroyed" describe something a run *would do*; this describes something that
 * already is, and blurring the two is how a reader ends up believing a diagram
 * proposed a change nobody wrote.
 */
export function summarizeReconciliation(result: Reconciliation): string {
  const { counts } = result;
  const findings = counts.unmanaged + counts.notApplied + counts.divergent;
  if (findings === 0) {
    return `The cloud matches the code: ${plural(counts.matching, "resource")}, all accounted for.`;
  }

  const headline: string[] = [];
  if (counts.unmanaged > 0) {
    headline.push(`${plural(counts.unmanaged, "resource")} not in the code`);
  }
  if (counts.notApplied > 0) {
    headline.push(`${plural(counts.notApplied, "resource")} not in the cloud`);
  }
  if (counts.divergent > 0) headline.push(`${counts.divergent} disagreeing`);

  return [
    [`**Reality vs code** — ${headline.join(", ")} (${counts.matching} match).`],
    section(
      "Not managed by this repository",
      result.unmanaged,
      "these exist in the cloud and nothing here describes them",
    ),
    section(
      "Declared but not found",
      result.notApplied,
      "the code describes these and the state does not have them",
    ),
    section(
      "Disagreeing",
      result.divergent,
      "present on both sides, with an attribute that differs",
    ),
  ]
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}
