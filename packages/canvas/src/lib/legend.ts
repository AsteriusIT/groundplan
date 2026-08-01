/**
 * What the diagram's encodings mean, as data.
 *
 * The labels and swatches used to live inside `graph-canvas.tsx`, where only
 * the canvas's own legend could reach them. A second legend — the VS Code
 * panel's, which is a popover rather than a permanent strip — would otherwise
 * have had to restate them, and two tables that both claim to say what "update"
 * looks like will eventually disagree.
 *
 * `presentOnly` is the one behavioural difference between the two. The canvas
 * legend has always listed every change state under `variant="plan"`, and it
 * still does; a legend that lists a state the diagram does not contain teaches
 * the reader to look for something that is not there, which is a trade the
 * panel makes and the web app does not.
 */
import type { Graph } from "../types";
import { isDataSource } from "./resource-category";
import type { FilterKey } from "./graph-layout";

export const FILTER_LABELS: Record<FilterKey, string> = {
  create: "Create",
  update: "Update",
  delete: "Delete",
  noop: "No change",
  impacted: "Impacted",
};

export const FILTER_SWATCH: Record<FilterKey, string> = {
  create: "bg-create",
  update: "bg-update",
  delete: "bg-delete",
  noop: "bg-edge",
  impacted: "bg-impacted",
};

/** Declaration order — the order a reader expects to meet these states in. */
const CHANGE_ORDER: readonly FilterKey[] = [
  "create",
  "update",
  "delete",
  "noop",
  "impacted",
];

export type LegendChange = {
  key: FilterKey;
  label: string;
  /** Tailwind class for the swatch — never a raw colour. */
  swatch: string;
  /** How many nodes are in this state. Zero when not counting presence. */
  count: number;
};

export type LegendEdge = {
  key: "depends_on" | "inferred";
  label: string;
  dashed: boolean;
};

export type LegendNote = { key: "data-source"; label: string };

export type LegendModel = {
  changes: LegendChange[];
  edges: LegendEdge[];
  notes: LegendNote[];
};

const EDGE_ENTRIES: readonly LegendEdge[] = [
  { key: "depends_on", label: "depends_on", dashed: false },
  { key: "inferred", label: "inferred reference", dashed: true },
];

/** How many nodes sit in each change state, impact counted as its own. */
function countStates(graph: Graph): Map<FilterKey, number> {
  const counts = new Map<FilterKey, number>();
  const bump = (key: FilterKey): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const node of graph.nodes) {
    // Impacted is not a plan action: an impacted node is unchanged, and
    // counting it under `noop` as well would double-count the same card.
    if (node.impacted === true) bump("impacted");
    else if (node.change !== null) bump(node.change);
  }
  return counts;
}

export function buildLegendModel(
  graph: Graph,
  {
    variant,
    presentOnly,
  }: Readonly<{ variant: "plan" | "docs"; presentOnly: boolean }>,
): LegendModel {
  const counts = countStates(graph);

  // A docs snapshot has no change data, so the entries would colour nothing.
  const changes: LegendChange[] =
    variant === "docs"
      ? []
      : CHANGE_ORDER.filter((key) => !presentOnly || (counts.get(key) ?? 0) > 0).map(
          (key) => ({
            key,
            label: FILTER_LABELS[key],
            swatch: FILTER_SWATCH[key],
            count: counts.get(key) ?? 0,
          }),
        );

  const drawn = new Set(
    graph.edges
      .filter((edge) => edge.kind === "depends_on")
      .map((edge) => (edge.inferred === true ? "inferred" : "depends_on")),
  );
  const edges = EDGE_ENTRIES.filter((entry) => !presentOnly || drawn.has(entry.key));

  // Data sources are read from the provider, not defined in the repo — the
  // muted card needs explaining, but only when one is actually on screen.
  // Presence-gated in both listings: this is what the canvas legend has always
  // done, so it is not something `presentOnly` gets to decide.
  const notes: LegendNote[] = graph.nodes.some((n) => isDataSource(n.id))
    ? [{ key: "data-source", label: "data source" }]
    : [];

  return { changes, edges: [...edges], notes };
}
