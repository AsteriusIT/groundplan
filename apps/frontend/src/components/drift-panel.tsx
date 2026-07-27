import { ArrowRight, RefreshCwOff, ShieldAlert, Trash2, X } from "lucide-react";

import type {
  AttributeDiffRow,
  DriftState,
  DriftedResource,
  PolicyViolation,
} from "@/api/types";
import { DocsLink } from "@/components/docs-link";
import { cn } from "@/lib/utils";
import { driftFreshness } from "@/lib/drift";
import { SEVERITY_CLASS } from "@/lib/policy";

/**
 * The drift rail (GP-207): what the cloud says about this estate that the code
 * does not.
 *
 * Three things happen here, in this order, because that is the order a reader
 * needs them in:
 *
 *  1. **When was this measured, and against what?** Always first, always
 *     present. Drift is the one thing in the product that can be confidently
 *     wrong — a measurement of last week's main, read as today's — so the
 *     provenance leads and a stale one is said out loud.
 *  2. **What did the drift break?** A violation that exists in the cloud but not
 *     in the code was introduced by nobody's pull request, so no review caught
 *     it. That is the strongest signal in here, and it goes above the inventory.
 *  3. **What drifted.** Each resource with the attributes that moved, clickable
 *     to fly the camera to it — the move the compliance rail and the IAM table
 *     both make.
 *
 * A stale measurement lists nothing at all. It is about a commit nobody is
 * looking at, and rows of confident before→after values against the wrong code
 * is worse than an empty panel with an explanation.
 */
export function DriftPanel({
  drift,
  onSelectAddress,
  onClose,
}: Readonly<{
  drift: DriftState;
  onSelectAddress: (address: string) => void;
  onClose: () => void;
}>) {
  const freshness = driftFreshness(drift);
  const usable = !drift.stale;
  const resources = usable ? drift.report.resources : [];
  const outsideIac = usable ? (drift.report.policy?.added ?? []) : [];

  return (
    <aside className="border-border bg-card flex w-80 shrink-0 flex-col overflow-y-auto border-l">
      <header className="border-border flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <RefreshCwOff className="text-muted-foreground size-4" />
          <h2 className="font-display text-sm font-semibold">Drift</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close drift panel"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="space-y-4 px-4 py-4">
        <output
          className={cn(
            "block rounded-md border px-3 py-2 text-xs",
            freshness.tone === "stale"
              ? "bg-warning-soft text-warning border-warning/40"
              : "text-muted-foreground border-border",
          )}
        >
          {freshness.text}
        </output>

        {/* GP-207: nobody reviewed this, because there was nothing to review. */}
        {outsideIac.length > 0 && (
          <section>
            <h3 className="text-drift font-mono text-[11px] tracking-[0.14em] uppercase">
              Introduced outside your code · {outsideIac.length}
            </h3>
            <p className="text-muted-foreground mt-1.5 text-xs">
              These violations exist in the cloud and not in the repository — no
              pull request introduced them, so no review caught them.
            </p>
            <ul className="mt-2 space-y-2">
              {outsideIac.map((violation) => (
                <OutsideIacRow
                  key={violation.ruleId + violation.address}
                  violation={violation}
                  onSelect={() => onSelectAddress(violation.address)}
                />
              ))}
            </ul>
          </section>
        )}

        {usable && resources.length === 0 && (
          <p className="text-muted-foreground text-xs">
            No drift: every resource Terraform manages matches the code.
          </p>
        )}

        {resources.length > 0 && (
          <section>
            <h3 className="text-muted-foreground font-mono text-[11px] tracking-[0.14em] uppercase">
              Drifted resources · {resources.length}
            </h3>
            <ul className="mt-2 space-y-2">
              {resources.map((resource) => (
                <DriftRow
                  key={resource.address}
                  resource={resource}
                  onSelect={() => onSelectAddress(resource.address)}
                />
              ))}
            </ul>
          </section>
        )}

        {/* A stale or empty rail is exactly where somebody asks "how do I
            measure this?", so the answer is here rather than three clicks away. */}
        <p className="text-muted-foreground border-t border-border pt-3 text-xs">
          Drift is measured by your own pipeline —{" "}
          <DocsLink page="driftAndReality" showIcon={false}>
            how to schedule it
          </DocsLink>
          .
        </p>
      </div>
    </aside>
  );
}

/** One violation the world introduced — the rule, what it says, and the fix. */
function OutsideIacRow({
  violation,
  onSelect,
}: Readonly<{ violation: PolicyViolation; onSelect: () => void }>) {
  return (
    <li className="border-drift/40 rounded-md border px-2.5 py-2 text-xs">
      <p className="flex items-center gap-1.5">
        <ShieldAlert className="text-drift size-3 shrink-0" />
        <span
          className={cn(
            "rounded-full border px-1.5 py-0.5 font-mono text-[10px] leading-none",
            SEVERITY_CLASS[violation.severity],
          )}
        >
          {violation.severity}
        </span>
        <code className="text-faint font-mono text-[10px]">{violation.ruleId}</code>
      </p>
      <button
        type="button"
        onClick={onSelect}
        className="hover:text-primary mt-1.5 block w-full text-left font-mono text-[11px] break-all"
      >
        {violation.address}
      </button>
      <p className="mt-1">{violation.message}</p>
      <p className="text-muted-foreground mt-1">{violation.hint}</p>
    </li>
  );
}

/** One drifted resource: its address, and what moved. */
function DriftRow({
  resource,
  onSelect,
}: Readonly<{ resource: DriftedResource; onSelect: () => void }>) {
  const gone = resource.change === "delete";
  return (
    <li className="border-border rounded-md border px-2.5 py-2 text-xs">
      <button
        type="button"
        onClick={onSelect}
        className="hover:text-primary block w-full text-left"
      >
        <span className="text-faint font-mono text-[10px]">{resource.type}</span>
        <span className="mt-0.5 block font-mono text-[11px] break-all">
          {resource.address}
        </span>
      </button>

      {gone ? (
        <p className="text-delete mt-1.5 flex items-center gap-1.5">
          <Trash2 className="size-3 shrink-0" />
          This resource no longer exists
        </p>
      ) : (
        <dl className="mt-1.5 space-y-1">
          {resource.attribute_diff.map((row) => (
            <DriftAttribute key={row.key} row={row} />
          ))}
        </dl>
      )}

      {resource.attribute_diff_truncated && (
        <p className="text-muted-foreground mt-1 text-[10px]">
          Only the first 20 changed attributes are shown.
        </p>
      )}
    </li>
  );
}

/** `key: before → after`, in the drift hue, never a change colour. */
function DriftAttribute({ row }: Readonly<{ row: AttributeDiffRow }>) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground font-mono text-[10px] break-all">
        {row.key}
      </dt>
      <dd className="flex items-center gap-1.5 font-mono text-[10px]">
        <span className="text-muted-foreground break-all line-through">
          {row.before ?? "—"}
        </span>
        <ArrowRight className="text-faint size-2.5 shrink-0" aria-hidden="true" />
        <span className="text-drift break-all">{row.after ?? "—"}</span>
      </dd>
    </div>
  );
}
