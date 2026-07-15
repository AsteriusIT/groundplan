import { useState } from "react";
import {
  ChevronDown,
  EyeOff,
  Group,
  Link2,
  StickyNote,
  Trash2,
  TriangleAlert,
  Type,
} from "lucide-react";

import type { Annotation, Graph, GraphNode } from "@/api/types";
import { AiBadge } from "@/components/ui/ai-badge";
import { reanchor, type Orphan } from "@/lib/annotations";
import { searchNodes } from "@/lib/graph-search";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const TYPE_ICON = {
  note: StickyNote,
  link: Link2,
  group: Group,
  hide: EyeOff,
  rename: Type,
} as const;

const TYPE_LABEL: Record<Annotation["type"], string> = {
  note: "Note",
  link: "Logical edge",
  group: "Group",
  hide: "Hide",
  rename: "Rename",
};

function excerpt(a: Annotation): string {
  return a.label || a.body || TYPE_LABEL[a.type];
}

/**
 * Orphan review (GP-59, tray as of GP-73): a non-blocking banner when annotations
 * have lost an anchor after a snapshot change, opening a list where each can be
 * re-anchored (search the current snapshot's addresses), kept as-is, or deleted.
 *
 * "Keep" is not a no-op dressed up as a button: an orphan is often a resource
 * that is *coming back* — mid-refactor, or moved to a branch — and the right
 * answer is to leave it alone and stop being asked. So Keep dismisses it from the
 * tray for this session without touching the annotation, which stays orphaned.
 *
 * Renders nothing when there are no orphans.
 */
export function OrphanReview({
  orphans,
  graph,
  onReanchor,
  onDelete,
}: Readonly<{
  orphans: Orphan[];
  graph: Graph;
  onReanchor: (id: string, anchors: string[]) => void;
  onDelete: (id: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());

  const shown = orphans.filter((o) => !kept.has(o.annotation.id));
  if (shown.length === 0) return null;

  const n = shown.length;
  return (
    <output
      className="block bg-warning-soft text-warning border-b border-warning/40 px-4 py-2"
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
          {shown.map(({ annotation, missing }) => (
            <OrphanRow
              key={annotation.id}
              annotation={annotation}
              missing={missing}
              graph={graph}
              onReanchor={(anchor, replacement) =>
                onReanchor(annotation.id, reanchor(annotation.anchors, anchor, replacement))
              }
              onKeep={() =>
                setKept((prev) => new Set([...prev, annotation.id]))
              }
              onDelete={() => onDelete(annotation.id)}
            />
          ))}
        </ul>
      )}
    </output>
  );
}

function OrphanRow({
  annotation,
  missing,
  graph,
  onReanchor,
  onKeep,
  onDelete,
}: Readonly<{
  annotation: Annotation;
  missing: string[];
  graph: Graph;
  onReanchor: (missingAnchor: string, replacement: string) => void;
  onKeep: () => void;
  onDelete: () => void;
}>) {
  const Icon = TYPE_ICON[annotation.type];
  return (
    <li className="border-warning/40 bg-warning/5 rounded-md border px-3 py-2">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-xs font-medium">
            {excerpt(annotation)}
            {annotation.provenance === "ai" && <AiBadge />}
          </p>
          <p className="text-warning/80 text-[11px]">
            {TYPE_LABEL[annotation.type]} · last updated{" "}
            {formatDate(annotation.updatedAt)}
          </p>
        </div>
        <button
          type="button"
          onClick={onKeep}
          title="Leave it orphaned and stop showing it here"
          className="hover:bg-warning/20 shrink-0 rounded px-2 py-0.5 text-[11px] font-medium"
        >
          Keep
        </button>
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
}: Readonly<{
  address: string;
  graph: Graph;
  onPick: (replacement: string) => void;
}>) {
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
