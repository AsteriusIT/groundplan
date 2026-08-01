/**
 * What the colours and lines mean — on request, and only about what is on
 * screen.
 *
 * The canvas draws a permanent eight-entry strip in the bottom-left corner.
 * In a panel this size that is a standing cost for something you read once,
 * and most of it is explaining states the diagram does not contain: a docs
 * snapshot has no creates to colour, and a graph with no data sources has no
 * muted cards to account for. `buildLegendModel(..., presentOnly: true)` is
 * the whole difference.
 */
import { HelpCircle } from "lucide-react";

import { buildLegendModel, cn, type Graph } from "@groundplan/canvas";

import { strings } from "../strings";
import { Popover } from "./popover";

export function LegendButton({
  graph,
  variant,
  open,
  onToggle,
  onClose,
}: Readonly<{
  graph: Graph;
  variant: "plan" | "docs";
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}>): React.JSX.Element {
  const model = buildLegendModel(graph, { variant, presentOnly: true });
  const empty =
    model.changes.length === 0 &&
    model.edges.length === 0 &&
    model.notes.length === 0;

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        aria-label={strings.legend.label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={strings.legend.open}
        onClick={onToggle}
        className="hover:text-foreground flex items-center"
      >
        <HelpCircle className="size-3.5" />
      </button>

      <Popover
        open={open}
        onClose={onClose}
        label={strings.legend.label}
        align="end"
        side="top"
      >
        {empty ? (
          <p className="text-muted-foreground text-[11px]">{strings.legend.empty}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {model.changes.map(({ key, label, swatch, count }) => (
              <span
                key={key}
                className="text-foreground flex items-center gap-1.5 font-mono text-[10px]"
              >
                <span className={cn("size-2 shrink-0 rounded-full", swatch)} />
                {label}
                {/* The legend doubles as a tally: how many, not just what. */}
                <span className="text-muted-foreground tabular-nums">({count})</span>
              </span>
            ))}
            {model.notes.map(({ key, label }) => (
              <span
                key={key}
                className="text-foreground flex items-center gap-1.5 font-mono text-[10px]"
              >
                <span className="bg-muted border-border size-2 shrink-0 rounded-full border" />
                {label}
              </span>
            ))}
            {model.edges.map(({ key, label, dashed }) => (
              <span
                key={key}
                className="text-foreground flex items-center gap-1.5 font-mono text-[10px]"
              >
                <svg width="18" height="6" aria-hidden="true" className="shrink-0">
                  <line
                    x1="0"
                    y1="3"
                    x2="18"
                    y2="3"
                    strokeWidth="1.5"
                    strokeDasharray={dashed ? "4 3" : undefined}
                    className={dashed ? "stroke-edge-inferred" : "stroke-edge"}
                  />
                </svg>
                {label}
              </span>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}
