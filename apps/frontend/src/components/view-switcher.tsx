import { useSearchParams } from "react-router-dom";

import { cn } from "@/lib/utils";

/** The two graph views (GP-44). "infra" is the default plan-impact/docs view. */
export type GraphView = "infra" | "network";

/**
 * Read/write the `?view` query param (default "infra"). Kept in the URL — like
 * the `?compare` param — so deep links and share links land on the right view.
 */
export function useGraphView(): { view: GraphView; setView: (v: GraphView) => void } {
  const [params, setParams] = useSearchParams();
  const view: GraphView = params.get("view") === "network" ? "network" : "infra";
  const setView = (next: GraphView): void => {
    const updated = new URLSearchParams(params);
    if (next === "network") updated.set("view", "network");
    else updated.delete("view");
    setParams(updated, { replace: true });
  };
  return { view, setView };
}

const OPTIONS: { key: GraphView; label: string }[] = [
  { key: "infra", label: "Plan impact" },
  { key: "network", label: "Network" },
];

/** Plan-impact ⇄ Network view tabs (GP-44). Underlined-tab styling. */
export function ViewSwitcher() {
  const { view, setView } = useGraphView();
  return (
    <div className="flex items-center gap-4" role="group" aria-label="Graph view">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={view === o.key}
          onClick={() => setView(o.key)}
          className={cn(
            "border-b-2 px-0.5 pb-1.5 font-mono text-xs transition-colors",
            view === o.key
              ? "border-primary text-ink"
              : "border-transparent text-muted-foreground hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
