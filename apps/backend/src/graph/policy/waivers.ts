/**
 * GP-204: applying waivers to a report, and reconciling them against a graph.
 *
 * Both are pure. A waiver's *effect* is not "the violation goes away" — it is
 * "the violation is marked as answered": it stays in the report, stays in the
 * pull-request comment, is counted apart, and stops deciding the verdict. A rule
 * that quietly stops firing is a rule nobody can audit, which is the failure
 * mode this whole story exists to prevent.
 *
 * Expiry is evaluated against a `now` the caller passes in, so the function
 * stays deterministic — a report is a function of its inputs, and a clock read
 * inside it would make two evaluations of the same snapshot differ.
 */
import { statusFrom } from "./engine.js";
import { violationKey } from "./types.js";
import type {
  PolicyCounts,
  PolicyReport,
  PolicyViolation,
} from "./types.js";

/** A waiver reduced to what applying it needs. */
export type ApplicableWaiver = {
  id: string;
  ruleId: string;
  address: string;
  reason: string;
  /** Null = no end date. */
  expiresAt: Date | null;
  /** An orphaned waiver names a resource that is gone; it suspends nothing. */
  status?: "active" | "orphaned";
  revokedAt?: Date | null;
};

/** Is this waiver in force at `now`? Revoked, orphaned or expired: no. */
export function waiverInForce(waiver: ApplicableWaiver, now: Date): boolean {
  if (waiver.revokedAt) return false;
  if (waiver.status === "orphaned") return false;
  if (waiver.expiresAt !== null && waiver.expiresAt <= now) return false;
  return true;
}

function countOf(violations: PolicyViolation[]): PolicyCounts {
  const counts: PolicyCounts = {
    error: 0,
    warning: 0,
    info: 0,
    waived: 0,
    total: violations.length,
  };
  for (const violation of violations) {
    if (violation.waiver) counts.waived += 1;
    else counts[violation.severity] += 1;
  }
  return counts;
}

/**
 * Mark the violations that a waiver in force answers, and recompute the counts
 * and the verdict from what is left. The report's version moves to 2 only when a
 * waiver is actually applied — the same rule the graph schema follows, so a
 * report from an estate with no waivers stays byte-identical to what it was.
 */
export function applyWaivers(
  report: PolicyReport,
  waivers: ApplicableWaiver[],
  now: Date,
): PolicyReport {
  const inForce = new Map(
    waivers
      .filter((waiver) => waiverInForce(waiver, now))
      .map((waiver) => [violationKey(waiver), waiver]),
  );
  if (inForce.size === 0) return report;

  let applied = false;
  const violations = report.violations.map((violation) => {
    const waiver = inForce.get(violationKey(violation));
    if (!waiver) return violation;
    applied = true;
    return {
      ...violation,
      waiver: {
        id: waiver.id,
        reason: waiver.reason,
        expiresAt: waiver.expiresAt ? waiver.expiresAt.toISOString() : null,
      },
    };
  });
  if (!applied) return report;

  const counts = countOf(violations);
  return {
    ...report,
    version: 2,
    counts,
    status: statusFrom(counts),
    violations,
  };
}

/**
 * Which waivers still name a resource that exists (GP-204) — the annotation
 * layer's reconciliation, applied to exemptions. A waiver whose resource vanished
 * flips to `orphaned` and suspends nothing; when the resource comes back it flips
 * straight back. Never a delete: an exemption somebody granted is a fact, and
 * deleting it on our own initiative would silently re-arm a rule they answered.
 */
export function reconcileWaivers(
  waivers: { id: string; address: string; status?: "active" | "orphaned" }[],
  addresses: ReadonlySet<string>,
): { id: string; status: "active" | "orphaned" }[] {
  return waivers.map((waiver) => ({
    id: waiver.id,
    status: addresses.has(waiver.address) ? "active" : "orphaned",
  }));
}
