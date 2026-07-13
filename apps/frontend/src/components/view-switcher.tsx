import { useSearchParams } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * The graph views:
 *   `infra`    the default plan-impact / docs canvas (GP-44)
 *   `adapted`  the same graph seen through the accepted annotations (GP-74)
 *   `c4`       the adapted graph collapsed to one node per group (GP-77)
 *   `network`  the vnet/subnet containment view (GP-44)
 *   `iam`      the role-assignment table (GP-48)
 *
 * `adapted` and `c4` are documentation views: they answer "what is this system",
 * which is a question about the repository, not about a pull request.
 */
export type GraphView = "infra" | "adapted" | "c4" | "network" | "iam";

const VIEWS: ReadonlySet<GraphView> = new Set<GraphView>([
  "infra",
  "adapted",
  "c4",
  "network",
  "iam",
]);

/**
 * Read/write the `?view` query param (default "infra"). Kept in the URL — like
 * the `?compare` param — so deep links and share links land on the right view.
 */
export function useGraphView(): { view: GraphView; setView: (v: GraphView) => void } {
  const [params, setParams] = useSearchParams();
  const raw = params.get("view") as GraphView | null;
  const view: GraphView = raw && VIEWS.has(raw) ? raw : "infra";
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

const LABELS: Record<Exclude<GraphView, "infra">, string> = {
  adapted: "Adapted",
  c4: "C4",
  network: "Network",
  iam: "IAM",
};

/**
 * The view tabs (GP-44/GP-48/GP-74/GP-77). Underlined-tab styling.
 *
 * Adapted and C4 appear on the docs page only. A pull request asks "what does
 * this change do", and the honest answer to that is the generated graph — an
 * annotation layer that hides and renames things is the wrong lens for reviewing
 * a diff.
 */
export function ViewSwitcher({ variant = "plan" }: { variant?: ViewSwitcherVariant }) {
  const { view, setView } = useGraphView();
  const keys: GraphView[] =
    variant === "docs"
      ? ["infra", "adapted", "c4", "network", "iam"]
      : ["infra", "network", "iam"];

  const options = keys.map((key) => ({
    key,
    label: key === "infra" ? INFRA_LABEL[variant] : LABELS[key],
  }));

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
