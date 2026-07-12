/**
 * IAM table (GP-48): the canvas⇄table switch made real for identity. A flat,
 * filterable, sortable projection of the graph's role assignments — principal →
 * role → scope — with a `privileged` badge and (in PR context) a change column.
 * No canvas, no React Flow; a plain token-styled table.
 */
import { useMemo, useState } from "react";
import { ArrowRight, Search, ShieldAlert } from "lucide-react";

import type { ChangeKind, Graph, GraphNode } from "@/api/types";
import { fuzzyMatch } from "@/lib/graph-search";
import { STATUS_META, changeLabel, statusOf } from "@/lib/status";
import { cn } from "@/lib/utils";
import { Chip } from "@/components/ui/chip";
import { NodeDetailsPanel } from "@/components/node-details-panel";

/** One projected role-assignment row. */
export interface IamRow {
  node: GraphNode;
  principal: string;
  role: string;
  scope: string;
  privileged: boolean;
  change: ChangeKind | null;
}

type SortKey = "principal" | "role" | "scope";

/** Project the graph's role-assignment nodes into flat rows. */
export function toIamRows(graph: Graph): IamRow[] {
  const rows: IamRow[] = [];
  for (const node of graph.nodes) {
    const ra = node.role_assignment;
    if (!ra) continue;
    rows.push({
      node,
      principal: ra.principal,
      role: ra.role,
      scope: ra.scope,
      privileged: node.privileged === true,
      change: node.change,
    });
  }
  return rows;
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "principal", label: "Principal" },
  { key: "role", label: "Role" },
  { key: "scope", label: "Scope" },
];

export function IamTable({
  graph,
  variant,
  onViewInPlanImpact,
}: {
  graph: Graph;
  /** "plan" shows the change column + row tint; "docs" omits both. */
  variant: "plan" | "docs";
  /** GP-49: jump to the plan-impact view with `node` selected (preserved). */
  onViewInPlanImpact?: (node: GraphNode) => void;
}) {
  const showChange = variant === "plan";
  const [query, setQuery] = useState("");
  const [privilegedOnly, setPrivilegedOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "role",
    dir: "asc",
  });
  // GP-49: the node whose detail panel is open (a row, or a principal/scope jump).
  const [selected, setSelected] = useState<GraphNode | null>(null);

  const nodeById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph],
  );
  const allRows = useMemo(() => toIamRows(graph), [graph]);

  const rows = useMemo(() => {
    const q = query.trim();
    const filtered = allRows.filter((r) => {
      if (privilegedOnly && !r.privileged) return false;
      if (q && !fuzzyMatch(q, `${r.principal} ${r.role} ${r.scope}`)) return false;
      return true;
    });
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort(
      (a, b) =>
        a[sort.key].localeCompare(b[sort.key]) * factor ||
        a.node.id.localeCompare(b.node.id),
    );
  }, [allRows, query, privilegedOnly, sort]);

  if (allRows.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-sm text-center">
          <div className="bg-accent text-primary mx-auto mb-4 grid size-12 place-items-center rounded-sm">
            <ShieldAlert className="size-6" />
          </div>
          <h2 className="font-display text-lg font-semibold">No IAM resources</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            This snapshot has no role assignments or managed identities.
          </p>
        </div>
      </div>
    );
  }

  const toggleSort = (key: SortKey): void =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );

  const arrow = (key: SortKey): string =>
    sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : "";

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex flex-wrap items-center gap-3 border-b px-8 py-3">
        <div className="bg-card border-border flex items-center gap-2 rounded-md border px-2.5 py-1.5">
          <Search className="text-muted-foreground size-4" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by principal, role, scope…"
            aria-label="Filter IAM rows"
            className="text-ink placeholder:text-muted-foreground w-56 bg-transparent font-mono text-xs outline-none"
          />
        </div>
        <button
          type="button"
          aria-pressed={privilegedOnly}
          onClick={() => setPrivilegedOnly((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors",
            privilegedOnly
              ? "border-exposed/40 bg-exposed-soft text-exposed"
              : "border-border text-muted-foreground hover:text-ink",
          )}
        >
          <ShieldAlert className="size-3.5" />
          Privileged only
        </button>
        <span className="text-muted-foreground ml-auto font-mono text-[11px]">
          {rows.length} of {allRows.length} assignment{allRows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Role assignments</caption>
          <thead className="bg-card sticky top-0 z-10">
            <tr className="border-border border-b">
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={
                    sort.key === col.key
                      ? sort.dir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  className="px-8 py-2.5 text-left font-mono text-[11px] tracking-[0.12em] uppercase"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className="text-muted-foreground hover:text-ink transition-colors"
                  >
                    {col.label}
                    {arrow(col.key)}
                  </button>
                </th>
              ))}
              {showChange && (
                <th
                  scope="col"
                  className="text-muted-foreground px-8 py-2.5 text-left font-mono text-[11px] tracking-[0.12em] uppercase"
                >
                  Change
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const status = statusOf(row.change);
              return (
                <tr
                  key={row.node.id}
                  onClick={() => setSelected(row.node)}
                  aria-selected={selected?.id === row.node.id}
                  className={cn(
                    "border-border/60 hover:bg-accent-soft aria-selected:bg-accent-soft cursor-pointer border-b transition-colors",
                    showChange && status && STATUS_META[status].soft,
                  )}
                >
                  <td className="px-8 py-2.5 align-top">
                    <CellValue value={row.principal} target={nodeById.get(row.principal)} onSelect={setSelected} />
                  </td>
                  <td className="px-8 py-2.5 align-top">
                    <div className="flex items-center gap-2">
                      <span className="text-ink font-mono text-xs">{row.role}</span>
                      {row.privileged && (
                        <Chip variant="exposed">
                          <ShieldAlert className="size-3" />
                          Privileged
                        </Chip>
                      )}
                    </div>
                  </td>
                  <td className="px-8 py-2.5 align-top">
                    <CellValue value={row.scope} target={nodeById.get(row.scope)} onSelect={setSelected} />
                  </td>
                  {showChange && (
                    <td className="px-8 py-2.5 align-top">
                      {status ? (
                        <Chip variant={status}>{changeLabel(row.change)}</Chip>
                      ) : (
                        <span className="text-faint font-mono text-xs">—</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && (
        <NodeDetailsPanel
          graph={graph}
          node={selected}
          onClose={() => setSelected(null)}
          onSelect={setSelected}
          showChange={showChange}
          footer={
            onViewInPlanImpact && (
              <button
                type="button"
                onClick={() => onViewInPlanImpact(selected)}
                className="text-primary hover:bg-accent-soft flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 font-mono text-xs transition-colors"
              >
                View in plan-impact
                <ArrowRight className="size-3.5" />
              </button>
            )
          }
        />
      )}
    </div>
  );
}

/**
 * A principal/scope cell. When the value is the address of a node in the
 * snapshot it becomes a link that opens that node's panel (GP-49); otherwise
 * it's plain truncated mono text with the full value on hover.
 */
function CellValue({
  value,
  target,
  onSelect,
}: {
  value: string;
  target?: GraphNode;
  onSelect: (node: GraphNode) => void;
}) {
  if (target) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(target);
        }}
        className="text-primary block max-w-xs truncate text-left font-mono text-xs underline-offset-2 hover:underline"
        title={value}
      >
        {value}
      </button>
    );
  }
  return (
    <span
      className="text-muted-foreground block max-w-xs truncate font-mono text-xs"
      title={value}
    >
      {value}
    </span>
  );
}
