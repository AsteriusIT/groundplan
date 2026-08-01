/**
 * Search, as a toolbar control rather than a box floating over the diagram.
 *
 * Collapsed to an icon until asked for: in a panel this narrow, a permanent
 * input costs a third of the bar for something most sessions never use. It
 * expands on click or `Ctrl/Cmd+F`, and folds away on Escape or an empty blur —
 * so it never has to be dismissed deliberately.
 */
import { useEffect, useRef } from "react";
import { Search, X } from "lucide-react";

import { ResourceIcon, searchNodes, shortType, type Graph } from "@groundplan/canvas";

import { strings } from "../strings";

export function SearchField({
  graph,
  open,
  query,
  onOpen,
  onClose,
  onQuery,
  onPick,
}: Readonly<{
  graph: Graph;
  open: boolean;
  query: string;
  onOpen: () => void;
  onClose: () => void;
  onQuery: (next: string) => void;
  onPick: (nodeId: string) => void;
}>): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        aria-label={strings.search.label}
        title={strings.search.label}
        onClick={onOpen}
        className="text-muted-foreground hover:text-foreground flex items-center p-1"
      >
        <Search className="size-3.5" />
      </button>
    );
  }

  const results = searchNodes(graph.nodes, query, 10);

  return (
    <div className="relative">
      <div className="border-border-strong bg-panel flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5">
        <Search className="text-muted-foreground size-3.5 shrink-0" />
        <input
          ref={input}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results[0]) onPick(results[0].id);
            if (event.key === "Escape") onClose();
          }}
          // Folding away on an empty blur means it never has to be dismissed.
          onBlur={() => {
            if (query === "") onClose();
          }}
          placeholder={strings.search.placeholder}
          aria-label={strings.search.label}
          className="placeholder:text-muted-foreground text-foreground w-36 min-w-0 bg-transparent text-xs outline-none"
        />
        <button
          type="button"
          aria-label={strings.search.close}
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground flex items-center"
        >
          <X className="size-3" />
        </button>
      </div>

      {query !== "" && results.length > 0 && (
        <ul className="border-border-strong bg-panel absolute right-0 z-30 mt-1 max-h-64 w-64 overflow-auto rounded-sm border shadow-lg">
          {results.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                onMouseDown={(event) => {
                  // Ahead of blur, or the list unmounts before the click lands.
                  event.preventDefault();
                  onPick(node.id);
                }}
                className="hover:bg-accent-soft flex w-full items-center gap-2 px-2 py-1 text-left"
              >
                <ResourceIcon
                  type={node.type}
                  className="text-muted-foreground size-4 shrink-0"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="font-mono text-xs">{shortType(node.type)}</span>
                  <span className="text-muted-foreground truncate font-mono text-[10px]">
                    {node.id}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
