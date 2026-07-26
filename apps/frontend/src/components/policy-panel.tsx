import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldOff, Unlink, X } from "lucide-react";

import {
  createWaiver,
  listWaivers,
  revokeWaiver,
} from "@/api/client";
import type {
  PolicyDelta,
  PolicyReport,
  PolicyViolation,
  PolicyWaiver,
} from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCan } from "@/rbac/use-can";
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
  repositoryId,
  onSelectAddress,
  onChanged,
  onClose,
}: Readonly<{
  report: PolicyReport;
  /** Present on a pull request; null for the documentation of a branch. */
  delta: PolicyDelta | null;
  /** Enables the waiver controls (GP-204). Omit for a read-only surface. */
  repositoryId?: string;
  onSelectAddress: (address: string) => void;
  /** Called after a waiver is granted or withdrawn, so the verdict is re-read. */
  onChanged?: () => void;
  onClose: () => void;
}>) {
  const canManage = useCan("policy:manage");
  const checked = checkedRuleCount(report.rules);
  const status = delta ? delta.status : report.status;
  const waived = report.violations.filter((v) => v.waiver);

  // GP-204: the orphan tray. A waiver whose resource is gone suspends nothing —
  // it is not deleted (an exemption somebody granted is a fact), so it has to be
  // somewhere a human can see it and decide.
  const [waivers, setWaivers] = useState<PolicyWaiver[]>([]);
  const [waiving, setWaiving] = useState<PolicyViolation | null>(null);

  const loadWaivers = useCallback(() => {
    if (!repositoryId) return;
    listWaivers(repositoryId)
      .then(setWaivers)
      .catch(() => setWaivers([]));
  }, [repositoryId]);
  useEffect(loadWaivers, [loadWaivers]);

  const orphaned = waivers.filter((w) => w.status === "orphaned");

  const afterChange = useCallback(() => {
    loadWaivers();
    onChanged?.();
  }, [loadWaivers, onChanged]);

  const waivable = repositoryId && canManage ? setWaiving : undefined;

  async function withdraw(id: string) {
    await revokeWaiver(id);
    afterChange();
  }

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
              onWaive={waivable}
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
              onWaive={waivable}
              muted
            />
          </>
        ) : (
          <>
            <Group
              title="Violations"
              violations={report.violations.filter((v) => !v.waiver)}
              onSelectAddress={onSelectAddress}
              onWaive={waivable}
              empty="No violations. Every enabled rule passed on this snapshot."
            />
            <Group
              title="Waived"
              violations={waived}
              onSelectAddress={onSelectAddress}
              onWithdraw={
                repositoryId && canManage ? (id) => void withdraw(id) : undefined
              }
              muted
            />
          </>
        )}

        {/* GP-204: waivers whose resource is no longer in the diagram. Kept, not
            deleted — and shown, so nobody discovers one by being surprised. */}
        {orphaned.length > 0 && (
          <section>
            <h3 className="text-muted-foreground font-mono text-[11px] tracking-[0.14em] uppercase">
              Waivers with no resource · {orphaned.length}
            </h3>
            <ul className="mt-2 space-y-2">
              {orphaned.map((waiver) => (
                <li
                  key={waiver.id}
                  className="border-border rounded-md border px-2.5 py-2 text-xs"
                >
                  <p className="flex items-center gap-1.5">
                    <Unlink className="text-muted-foreground size-3" />
                    <code className="text-faint font-mono text-[10px]">
                      {waiver.ruleId}
                    </code>
                  </p>
                  <p className="mt-1 font-mono text-[11px] break-all">
                    {waiver.address}
                  </p>
                  <p className="text-muted-foreground mt-1">
                    This resource is no longer in the diagram, so the waiver
                    suspends nothing. It comes back if the resource does.
                  </p>
                  {canManage && repositoryId && (
                    <button
                      type="button"
                      onClick={() => void withdraw(waiver.id)}
                      className="text-destructive mt-1.5 text-[11px] underline-offset-2 hover:underline"
                    >
                      Withdraw it
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {waiving && repositoryId && (
        <WaiveDialog
          violation={waiving}
          repositoryId={repositoryId}
          onClose={() => setWaiving(null)}
          onWaived={() => {
            setWaiving(null);
            afterChange();
          }}
        />
      )}
    </aside>
  );
}

/**
 * Granting an exemption (GP-204). The reason is required by the form and by the
 * API: it is the only thing that makes a waiver reviewable later, and an expiry
 * is offered because most exemptions are "not yet", not "never".
 */
function WaiveDialog({
  violation,
  repositoryId,
  onClose,
  onWaived,
}: Readonly<{
  violation: PolicyViolation;
  repositoryId: string;
  onClose: () => void;
  onWaived: () => void;
}>) {
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await createWaiver(repositoryId, {
        ruleId: violation.ruleId,
        address: violation.address,
        reason: reason.trim(),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      onWaived();
    } catch {
      setError("Could not waive this violation.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">Waive this violation</DialogTitle>
          <DialogDescription>
            It stays in every report and every pull-request comment, marked and
            counted apart — a waiver answers a finding, it does not hide one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="border-border rounded-md border px-3 py-2 text-xs">
            <code className="font-mono">{violation.ruleId}</code>
            <span className="mt-1 block font-mono break-all">
              {violation.address}
            </span>
          </p>

          <div className="space-y-2">
            <Label htmlFor="waiver-reason">Reason</Label>
            <Textarea
              id="waiver-reason"
              value={reason}
              rows={3}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this acceptable here?"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="waiver-expiry">Expires (optional)</Label>
            <Input
              id="waiver-expiry"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              After this date the violation is active again at the next report.
              Leave it empty for a waiver with no end date.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={saving || reason.trim() === ""}
          >
            <ShieldOff className="size-4" />
            {saving ? "Waiving…" : "Waive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Group({
  title,
  violations,
  onSelectAddress,
  onWaive,
  onWithdraw,
  empty,
  muted = false,
}: Readonly<{
  title: string;
  violations: PolicyViolation[];
  onSelectAddress: (address: string) => void;
  /** GP-204: offered on active violations, to admins, when a repo is in scope. */
  onWaive?: (violation: PolicyViolation) => void;
  /** GP-204: withdraw the waiver that answers this violation. */
  onWithdraw?: (waiverId: string) => void;
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
                  {violation.waiver.expiresAt &&
                    ` (until ${violation.waiver.expiresAt.slice(0, 10)})`}
                </span>
              )}
            </button>
            {onWaive && !violation.waiver && (
              <button
                type="button"
                onClick={() => onWaive(violation)}
                className="text-muted-foreground hover:text-foreground mt-1 ml-2.5 text-[11px] underline-offset-2 hover:underline"
              >
                Waive…
              </button>
            )}
            {onWithdraw && violation.waiver && (
              <button
                type="button"
                onClick={() => onWithdraw(violation.waiver!.id)}
                className="text-muted-foreground hover:text-foreground mt-1 ml-2.5 text-[11px] underline-offset-2 hover:underline"
              >
                Withdraw the waiver
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
