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

/** Segmented Plan-impact ⇄ Network switcher (GP-44). */
export function ViewSwitcher() {
  const { view, setView } = useGraphView();
  return (
    <div
      className="border-border inline-flex rounded-md border p-0.5"
      role="group"
      aria-label="Graph view"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={view === o.key}
          onClick={() => setView(o.key)}
          className={cn(
            "rounded px-2.5 py-1 font-mono text-[11px] transition-colors",
            view === o.key ? "bg-accent text-ink" : "text-muted-foreground hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
