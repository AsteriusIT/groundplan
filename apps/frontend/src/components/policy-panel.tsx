import { ShieldCheck, X } from "lucide-react";

import type { PolicyDelta, PolicyReport, PolicyViolation } from "@/api/types";
import { cn } from "@/lib/utils";
import {
  SEVERITY_CLASS,
  STATUS_CLASS,
  STATUS_LABEL,
  checkedRuleCount,
} from "@/lib/policy";

/**
 * The compliance rail (GP-202/GP-203): every violation on this snapshot, and —
 * on a pull request — what this change introduced, listed first and apart from
 * the estate's existing debt.
 *
 * Clicking a violation flies the camera to its resource, the same move the IAM
 * table makes. Nothing here is hidden: a waived violation is greyed and carries
 * its reason, because a rule that quietly stops firing is a rule nobody can
 * audit.
 */
export function PolicyPanel({
  report,
  delta,
  onSelectAddress,
  onClose,
}: Readonly<{
  report: PolicyReport;
  /** Present on a pull request; null for the documentation of a branch. */
  delta: PolicyDelta | null;
  onSelectAddress: (address: string) => void;
  onClose: () => void;
}>) {
  const checked = checkedRuleCount(report.rules);
  const status = delta ? delta.status : report.status;
  const waived = report.violations.filter((v) => v.waiver);

  return (
    <aside className="border-border bg-card flex w-80 shrink-0 flex-col overflow-y-auto border-l">
      <header className="border-border flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-muted-foreground size-4" />
          <h2 className="font-display text-sm font-semibold">Compliance</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close compliance panel"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="space-y-4 px-4 py-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 font-mono text-[11px] leading-none font-medium",
              STATUS_CLASS[status],
            )}
          >
            {STATUS_LABEL[status]}
          </span>
          <span className="text-muted-foreground text-xs">
            {checked} rule{checked === 1 ? "" : "s"} checked
          </span>
        </div>

        {checked === 0 && (
          <p className="text-muted-foreground text-xs">
            No enabled rule applies to this snapshot, so nothing was checked —
            which is not the same as nothing being wrong.
          </p>
        )}

        {delta?.baseSnapshotId === null && (
          <p className="text-muted-foreground border-border rounded-md border px-3 py-2 text-xs">
            There is no documentation of the default branch to compare against
            yet, so everything below reads as new.
          </p>
        )}

        {delta ? (
          <>
            <Group
              title="Introduced by this change"
              violations={delta.added}
              onSelectAddress={onSelectAddress}
              empty="Nothing new. This change introduces no violations."
            />
            <Group
              title="Resolved by this change"
              violations={delta.resolved}
              onSelectAddress={onSelectAddress}
              muted
            />
            <Group
              title="Already on the default branch"
              violations={delta.preexisting}
              onSelectAddress={onSelectAddress}
              muted
            />
          </>
        ) : (
          <>
            <Group
              title="Violations"
              violations={report.violations.filter((v) => !v.waiver)}
              onSelectAddress={onSelectAddress}
              empty="No violations. Every enabled rule passed on this snapshot."
            />
            <Group
              title="Waived"
              violations={waived}
              onSelectAddress={onSelectAddress}
              muted
            />
          </>
        )}
      </div>
    </aside>
  );
}

function Group({
  title,
  violations,
  onSelectAddress,
  empty,
  muted = false,
}: Readonly<{
  title: string;
  violations: PolicyViolation[];
  onSelectAddress: (address: string) => void;
  empty?: string;
  muted?: boolean;
}>) {
  if (violations.length === 0) {
    if (!empty) return null;
    return (
      <section>
        <h3 className="text-muted-foreground font-mono text-[11px] tracking-[0.14em] uppercase">
          {title}
        </h3>
        <p className="text-muted-foreground mt-2 text-xs">{empty}</p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="text-muted-foreground font-mono text-[11px] tracking-[0.14em] uppercase">
        {title} · {violations.length}
      </h3>
      <ul className="mt-2 space-y-2">
        {violations.map((violation) => (
          <li key={`${violation.ruleId} ${violation.address}`}>
            <button
              type="button"
              onClick={() => onSelectAddress(violation.address)}
              className={cn(
                "border-border hover:bg-accent block w-full rounded-md border px-2.5 py-2 text-left text-xs transition-colors",
                (muted || violation.waiver) && "opacity-60",
              )}
              title={
                violation.waiver
                  ? `Waived: ${violation.waiver.reason}`
                  : violation.hint
              }
            >
              <span className="flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    "rounded-full border px-1.5 py-0.5 font-mono text-[10px] leading-none",
                    SEVERITY_CLASS[violation.severity],
                  )}
                >
                  {violation.severity}
                </span>
                <code className="text-faint font-mono text-[10px]">
                  {violation.ruleId}
                </code>
                {violation.waiver && (
                  <span className="bg-muted text-muted-foreground border-border rounded-full border px-1.5 py-0.5 font-mono text-[10px] leading-none">
                    waived
                  </span>
                )}
              </span>
              <span className="mt-1 block font-mono text-[11px] break-all">
                {violation.address}
              </span>
              <span className="text-muted-foreground mt-1 block">
                {violation.message}
              </span>
              {violation.waiver && (
                <span className="text-muted-foreground mt-1 block italic">
                  Waived: {violation.waiver.reason}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
