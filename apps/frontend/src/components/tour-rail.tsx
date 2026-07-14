/**
 * GP-79: the guide chrome — the whole tour, in a rail beside the canvas.
 *
 * The spotlight shows you one stop and hides the shape of the walk. This shows the
 * shape: every stop, in order, current one expanded, any of them one click away.
 * It reads as a document that happens to move the camera, which is what you want
 * when you are reviewing rather than being shown around — you can see how long
 * this is going to take, and you can go back to the stop that bothered you.
 *
 * Docked as a flex sibling of the canvas (the shape `ProposalInbox` already uses),
 * not floated over it: it is a place, not an interruption.
 */
import { X } from "lucide-react";

import type { Tour } from "@/api/types";
import { AiResponse } from "@/components/ai-response";
import { AiBadge } from "@/components/ui/ai-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function TourRail({
  tour,
  index,
  model,
  onGoTo,
  onNext,
  onPrev,
  onExit,
}: {
  tour: Tour;
  index: number;
  model: string | null;
  onGoTo: (index: number) => void;
  onNext: () => void;
  onPrev: () => void;
  onExit: () => void;
}) {
  const total = tour.steps.length;
  const last = index === total - 1;

  return (
    <aside
      className="border-border bg-panel flex w-80 shrink-0 flex-col border-l"
      aria-label="Guided tour"
    >
      <div className="border-border border-b px-4 py-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-primary font-mono text-[10px] tracking-wider uppercase">
            Tour · {total} stops
          </span>
          <button
            type="button"
            onClick={onExit}
            aria-label="End tour"
            className="text-muted-foreground hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <h2 className="font-display text-ink text-sm leading-snug font-semibold">
          {tour.title}
        </h2>
        <div className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-[10px]">
          <AiBadge />
          {model ? <span className="font-mono">{model}</span> : null}
        </div>
      </div>

      <ol className="flex-1 overflow-y-auto px-4 py-3">
        {tour.steps.map((step, i) => {
          const current = i === index;
          return (
            <li
              key={`${i}-${step.title}`}
              className={cn(
                "border-l-2 py-1.5 pl-3",
                current ? "border-primary" : "border-border",
              )}
            >
              <button
                type="button"
                onClick={() => onGoTo(i)}
                aria-current={current ? "step" : undefined}
                className="w-full text-left"
              >
                <span className="text-muted-foreground font-mono text-[10px]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span
                  className={cn(
                    "block text-xs leading-snug",
                    current
                      ? "font-display text-ink text-sm font-semibold"
                      : "text-muted-foreground",
                  )}
                >
                  {step.title}
                </span>
              </button>

              {current ? (
                <>
                  <AiResponse markdown={step.body} className="mt-1.5" />
                  <div className="mt-2.5 flex gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={onPrev}
                      disabled={index === 0}
                    >
                      Back
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={onNext}
                    >
                      {last ? "Done" : "Next"}
                    </Button>
                  </div>
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
