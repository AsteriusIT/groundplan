/**
 * GP-202: what a pull request *changes* about compliance.
 *
 * A report on its own answers "is this estate compliant"; on a pull request that
 * is the wrong question. An estate carries debt, and a reviewer who is shown all
 * of it on every change learns to scroll past the list — so the head's report is
 * compared with main's, and what the change introduced leads.
 *
 * Pure and deterministic, like everything else here: two reports in, one delta
 * out, sorted by the same total order the reports themselves use.
 */
import { SEVERITY_RANK, violationKey } from "./types.js";
import type {
  PolicyReport,
  PolicyStatus,
  PolicyViolation,
} from "./types.js";

/**
 * How a head snapshot's violations compare with the documentation of main.
 * Versioned in place like the report, for the same reason.
 */
export type PolicyDelta = {
  version: 1;
  /** Violations this change introduces — what a reviewer is here for. */
  added: PolicyViolation[];
  /** Violations main has that this change removes. */
  resolved: PolicyViolation[];
  /** Violations on both sides: the estate's existing debt, not this change's. */
  preexisting: PolicyViolation[];
  /**
   * The verdict on the **new** violations only. Informative in v1 — nothing is
   * blocked; a native CI gate comes with the Checks port (GP-192).
   */
  status: PolicyStatus;
  /**
   * The documentation snapshot this was compared against, or null when there was
   * none. Null is not "clean": with no baseline nothing can be called
   * pre-existing, so everything reads as new and the reader is told why.
   */
  baseSnapshotId: string | null;
};

function compare(a: PolicyViolation, b: PolicyViolation): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.address.localeCompare(b.address) ||
    a.ruleId.localeCompare(b.ruleId) ||
    a.message.localeCompare(b.message)
  );
}

/** Worst *active* new violation decides the pull request's policy status. */
function statusOf(added: PolicyViolation[]): PolicyStatus {
  const active = added.filter((v) => !v.waiver);
  if (active.some((v) => v.severity === "error")) return "failing";
  if (active.some((v) => v.severity === "warning")) return "warnings";
  return "passing";
}

/**
 * Compare a head report with main's. Identity is rule × resource: the same rule
 * firing on the same address is the same violation, even if its message changed
 * because the resource did.
 */
export function diffPolicyReports(
  head: PolicyReport,
  base: { report: PolicyReport; snapshotId: string } | null,
): PolicyDelta {
  if (!base) {
    return {
      version: 1,
      added: [...head.violations].sort(compare),
      resolved: [],
      preexisting: [],
      status: statusOf(head.violations),
      baseSnapshotId: null,
    };
  }

  const baseKeys = new Set(base.report.violations.map(violationKey));
  const headKeys = new Set(head.violations.map(violationKey));

  const added = head.violations.filter((v) => !baseKeys.has(violationKey(v)));
  const preexisting = head.violations.filter((v) => baseKeys.has(violationKey(v)));
  const resolved = base.report.violations.filter(
    (v) => !headKeys.has(violationKey(v)),
  );

  return {
    version: 1,
    added: added.sort(compare),
    resolved: resolved.sort(compare),
    preexisting: preexisting.sort(compare),
    status: statusOf(added),
    baseSnapshotId: base.snapshotId,
  };
}

const STATUS_WORD: Record<PolicyStatus, string> = {
  failing: "failing",
  warnings: "warnings",
  passing: "passing",
};

/** Rows shown per section of the pull-request comment. */
const SECTION_CAP = 10;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function line(violation: PolicyViolation): string {
  const base = `- \`${violation.address}\` — ${violation.message} (${violation.ruleId})`;
  return violation.waiver
    ? `${base} — waived: ${violation.waiver.reason}`
    : base;
}

function section(title: string, violations: PolicyViolation[]): string[] {
  if (violations.length === 0) return [];
  const rows = violations.slice(0, SECTION_CAP).map(line);
  if (violations.length > SECTION_CAP) {
    rows.push(`…and ${violations.length - SECTION_CAP} more`);
  }
  return [`**${title}**`, ...rows];
}

/**
 * The Policy section of the pull-request comment (GP-202). New violations lead;
 * what the change *fixed* is said out loud, because a policy that only ever
 * complains is a policy people route around; pre-existing debt is counted, not
 * listed — it is not this change's to answer for.
 *
 * Returns null when the engine had nothing to say (no enabled rule applies), so
 * the caller omits the section entirely rather than printing a hollow pass.
 */
export function summarizePolicyDelta(
  delta: PolicyDelta,
  head: PolicyReport,
): string | null {
  const checked = head.rules.filter((r) => r.enabled && r.applicable).length;
  if (checked === 0) return null;

  const activeAdded = delta.added.filter((v) => !v.waiver);
  const waivedAdded = delta.added.filter((v) => v.waiver);

  const counts: string[] = [];
  for (const severity of ["error", "warning", "info"] as const) {
    const n = activeAdded.filter((v) => v.severity === severity).length;
    if (n > 0) counts.push(plural(n, `new ${severity === "info" ? "note" : severity}`));
  }
  if (waivedAdded.length > 0) counts.push(`${waivedAdded.length} new but waived`);

  const trailing: string[] = [];
  if (delta.resolved.length > 0) {
    trailing.push(`${delta.resolved.length} resolved`);
  }
  if (delta.preexisting.length > 0) {
    trailing.push(`${delta.preexisting.length} pre-existing`);
  }

  const headline =
    counts.length > 0
      ? `**Policy: ${STATUS_WORD[delta.status]}** · ${counts.join(" · ")}`
      : `**Policy: ${STATUS_WORD[delta.status]}** · no new violations`;
  const suffix = trailing.length > 0 ? ` (${trailing.join(", ")})` : "";

  const blocks: string[][] = [
    [headline + suffix],
    ...(delta.baseSnapshotId === null
      ? [
          [
            "_No documentation of the default branch to compare against yet — everything below reads as new._",
          ],
        ]
      : []),
    section("New violations", activeAdded),
    section("New, but waived", waivedAdded),
    section("Resolved by this change", delta.resolved),
  ];

  return blocks
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}
