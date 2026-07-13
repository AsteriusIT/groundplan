import { useState } from "react";
import { ChevronDown, Link2, Group, StickyNote, Trash2, TriangleAlert } from "lucide-react";

import type { Annotation, Graph, GraphNode } from "@/api/types";
import { reanchor, type Orphan } from "@/lib/annotations";
import { searchNodes } from "@/lib/graph-search";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const TYPE_ICON = { note: StickyNote, link: Link2, group: Group } as const;

function excerpt(a: Annotation): string {
  return a.label || a.body || "(untitled)";
}

/**
 * Orphan review (GP-59): a non-blocking banner when annotations have lost an
 * anchor after a snapshot change, opening a list where each can be re-anchored
 * (search the current snapshot's addresses) or deleted. Closes the GP-57
 * reconciliation loop on the UX side. Renders nothing when there are no orphans.
 */
export function OrphanReview({
  orphans,
  graph,
  onReanchor,
  onDelete,
}: {
  orphans: Orphan[];
  graph: Graph;
  onReanchor: (id: string, anchors: string[]) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (orphans.length === 0) return null;

  const n = orphans.length;
  return (
    <div
      role="status"
      className="bg-warning-soft text-warning border-b border-warning/40 px-4 py-2"
    >
      <div className="flex items-center justify-center gap-2">
        <TriangleAlert className="size-4" />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 text-xs font-medium"
        >
          {n} annotation{n === 1 ? "" : "s"} lost {n === 1 ? "its" : "their"} anchor
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && (
        <ul className="mx-auto mt-2 max-w-2xl space-y-2">
          {orphans.map(({ annotation, missing }) => (
            <OrphanRow
              key={annotation.id}
              annotation={annotation}
              missing={missing}
              graph={graph}
              onReanchor={(anchor, replacement) =>
                onReanchor(annotation.id, reanchor(annotation.anchors, anchor, replacement))
              }
              onDelete={() => onDelete(annotation.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrphanRow({
  annotation,
  missing,
  graph,
  onReanchor,
  onDelete,
}: {
  annotation: Annotation;
  missing: string[];
  graph: Graph;
  onReanchor: (missingAnchor: string, replacement: string) => void;
  onDelete: () => void;
}) {
  const Icon = TYPE_ICON[annotation.type];
  return (
    <li className="border-warning/40 bg-warning/5 rounded-md border px-3 py-2">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{excerpt(annotation)}</p>
          <p className="text-warning/80 text-[11px]">
            last updated {formatDate(annotation.updatedAt)}
          </p>
        </div>
        <button
          type="button"
          aria-label="Delete annotation"
          onClick={onDelete}
          className="hover:text-destructive grid size-6 shrink-0 place-items-center rounded"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {missing.map((address) => (
          <MissingAnchor
            key={address}
            address={address}
            graph={graph}
            onPick={(replacement) => onReanchor(address, replacement)}
          />
        ))}
      </ul>
    </li>
  );
}

function MissingAnchor({
  address,
  graph,
  onPick,
}: {
  address: string;
  graph: Graph;
  onPick: (replacement: string) => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const results = query ? searchNodes(graph.nodes, query, 8) : [];

  return (
    <li className="border-warning/30 bg-warning-soft rounded border px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <code className="text-warning min-w-0 flex-1 truncate font-mono text-[11px] line-through">
          {address}
        </code>
        {!searching && (
          <button
            type="button"
            onClick={() => setSearching(true)}
            className="bg-warning/20 hover:bg-warning/30 shrink-0 rounded px-2 py-0.5 text-[11px] font-medium"
          >
            Re-anchor
          </button>
        )}
      </div>
      {searching && (
        <div className="mt-1.5">
          <input
            aria-label="Search resources to re-anchor"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search resources…"
            className="border-warning/40 bg-card text-foreground w-full rounded border px-2 py-1 text-xs outline-none"
          />
          {results.length > 0 && (
            <ul className="border-warning/30 bg-card text-foreground mt-1 max-h-40 overflow-auto rounded border">
              {results.map((node: GraphNode) => (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => onPick(node.id)}
                    className="hover:bg-accent block w-full truncate px-2 py-1 text-left font-mono text-[11px]"
                  >
                    {node.id}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
