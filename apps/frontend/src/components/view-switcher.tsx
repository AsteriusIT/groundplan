import { useSearchParams } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * The graph views: "infra" (default plan-impact/docs canvas, GP-44), "network"
 * (GP-44), and "iam" (the role-assignment table, GP-48).
 */
export type GraphView = "infra" | "network" | "iam";

/**
 * Read/write the `?view` query param (default "infra"). Kept in the URL — like
 * the `?compare` param — so deep links and share links land on the right view.
 */
export function useGraphView(): { view: GraphView; setView: (v: GraphView) => void } {
  const [params, setParams] = useSearchParams();
  const raw = params.get("view");
  const view: GraphView = raw === "network" || raw === "iam" ? raw : "infra";
  const setView = (next: GraphView): void => {
    const updated = new URLSearchParams(params);
    if (next === "infra") updated.delete("view");
    else updated.set("view", next);
    setParams(updated, { replace: true });
  };
  return { view, setView };
}

/**
 * The "infra" tab is the same view either way, but it reads differently by
 * context: on a pull request it is the impact of the plan, on the docs page it
 * is simply everything the repository builds.
 */
export type ViewSwitcherVariant = "plan" | "docs";

const INFRA_LABEL: Record<ViewSwitcherVariant, string> = {
  plan: "Plan impact",
  docs: "Global",
};

/** Infra ⇄ Network ⇄ IAM view tabs (GP-44/GP-48). Underlined-tab styling. */
export function ViewSwitcher({ variant = "plan" }: { variant?: ViewSwitcherVariant }) {
  const { view, setView } = useGraphView();
  const options: { key: GraphView; label: string }[] = [
    { key: "infra", label: INFRA_LABEL[variant] },
    { key: "network", label: "Network" },
    { key: "iam", label: "IAM" },
  ];
  return (
    <div className="flex items-center gap-4" role="group" aria-label="Graph view">
      {options.map((o) => (
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
