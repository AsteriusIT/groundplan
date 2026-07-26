/**
 * Turning a policy report into what the canvas and the panels need (GP-202).
 *
 * The badge mechanic is the studio's lint one (GP-142) — a severity dot on the
 * node, a section in its detail panel — because a violation *is* a finding
 * anchored to an address, and drawing it twice would mean two mechanics to keep
 * in step. The only translation is the vocabulary: a policy speaks in
 * error/warning/info, the canvas badge in high/warn/info.
 */
import type { LintFinding, LintSeverity } from "@groundplan/canvas";

import type {
  PolicyDelta,
  PolicySeverity,
  PolicyStatus,
  PolicyViolation,
} from "@/api/types";

const BADGE_SEVERITY: Record<PolicySeverity, LintSeverity> = {
  error: "high",
  warning: "warn",
  info: "info",
};

/** Violations by node id, in the shape the canvas already renders. */
export function findingsByNode(
  violations: PolicyViolation[],
): Map<string, LintFinding[]> {
  const byNode = new Map<string, LintFinding[]>();
  for (const violation of violations) {
    // A waived violation keeps its place in the list but loses its badge: it has
    // been answered, and a canvas that still shouts about it teaches people to
    // ignore the badge.
    if (violation.waiver) continue;
    const finding: LintFinding = {
      ruleId: violation.ruleId,
      severity: BADGE_SEVERITY[violation.severity],
      terraformAddress: violation.address,
      message: violation.message,
      fixHint: violation.hint,
    };
    const existing = byNode.get(violation.address);
    if (existing) existing.push(finding);
    else byNode.set(violation.address, [finding]);
  }
  return byNode;
}

/** The nodes a pull request's *new* violations sit on — what a reviewer is here for. */
export function newViolationAddresses(delta: PolicyDelta | null): Set<string> {
  return new Set((delta?.added ?? []).map((v) => v.address));
}

export const STATUS_LABEL: Record<PolicyStatus, string> = {
  passing: "Passing",
  warnings: "Warnings",
  failing: "Failing",
};

/** Status → the hue the product already uses for that weight of news. */
export const STATUS_CLASS: Record<PolicyStatus, string> = {
  failing: "bg-delete-soft text-delete border-delete/30",
  warnings: "bg-update-soft text-update border-update/30",
  passing: "bg-create-soft text-create border-create/30",
};

export const SEVERITY_CLASS: Record<PolicySeverity, string> = {
  error: "bg-delete-soft text-delete border-delete/30",
  warning: "bg-update-soft text-update border-update/30",
  info: "bg-impacted-soft text-impacted border-impacted/30",
};

/** How many rules actually produced a verdict on this snapshot. */
export function checkedRuleCount(rules: { enabled: boolean; applicable: boolean }[]): number {
  return rules.filter((r) => r.enabled && r.applicable).length;
}
