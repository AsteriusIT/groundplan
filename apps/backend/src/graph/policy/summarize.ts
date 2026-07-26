/**
 * GP-200: a policy report as deterministic Markdown — the same kind of artefact
 * as the change summary (GP-36), and written to the same rules: pure function,
 * no adjectives, every line derivable from the report, byte-stable so it can be
 * golden-tested and pasted into a pull request comment unchanged.
 *
 * Section order is the order a reader cares about: errors, then warnings, then
 * info, then what has been waived — because a waiver is an answer somebody gave
 * and it belongs at the bottom of the page, not hidden off it.
 */
import type { PolicyReport, PolicySeverity, PolicyViolation } from "./types.js";

/** Rows shown per section before the "…and n more" overflow line. */
const SECTION_CAP = 10;

const SEVERITY_HEADING: Record<PolicySeverity, string> = {
  error: "Errors",
  warning: "Warnings",
  info: "Notes",
};

const STATUS_LABEL: Record<PolicyReport["status"], string> = {
  passing: "passing",
  warnings: "warnings",
  failing: "failing",
};

/** "1 error" / "2 errors" — plural without a library. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function capped(items: string[]): string[] {
  if (items.length <= SECTION_CAP) return items;
  const shown = items.slice(0, SECTION_CAP);
  shown.push(`…and ${items.length - SECTION_CAP} more`);
  return shown;
}

/** `- \`address\` — message (rule-id)`, plus the waiver's reason when waived. */
function line(violation: PolicyViolation): string {
  const base = `- \`${violation.address}\` — ${violation.message} (${violation.ruleId})`;
  if (!violation.waiver) return base;
  return `${base} — waived: ${violation.waiver.reason}`;
}

function section(title: string, violations: PolicyViolation[]): string[] {
  if (violations.length === 0) return [];
  return [`**${title}**`, ...capped(violations.map(line))];
}

/** The bold headline: the verdict, the counts that are non-zero, the coverage. */
function headline(report: PolicyReport): string {
  const { counts } = report;
  const segments: string[] = [];
  if (counts.error > 0) segments.push(plural(counts.error, "error"));
  if (counts.warning > 0) segments.push(plural(counts.warning, "warning"));
  if (counts.info > 0) segments.push(plural(counts.info, "note"));
  if (counts.waived > 0) segments.push(`${counts.waived} waived`);
  const checked = report.rules.filter((r) => r.enabled && r.applicable).length;
  const coverage = `${plural(checked, "rule")} checked`;
  if (segments.length === 0) {
    return `**Policy: ${STATUS_LABEL[report.status]}** (${coverage}, no violations)`;
  }
  return `**Policy: ${STATUS_LABEL[report.status]}** · ${segments.join(" · ")} (${coverage})`;
}

/**
 * Render a report to Markdown. A report where nothing could be checked says so
 * rather than claiming a pass — "no rules apply here" and "everything passed"
 * are different facts, and only one of them is reassuring.
 */
export function summarizePolicyReport(report: PolicyReport): string {
  const checked = report.rules.filter((r) => r.enabled && r.applicable).length;
  if (checked === 0) {
    return "**Policy: not evaluated** — no enabled rule applies to this snapshot.";
  }

  const active = report.violations.filter((v) => !v.waiver);
  const waived = report.violations.filter((v) => v.waiver);
  const bySeverity = (severity: PolicySeverity) =>
    active.filter((v) => v.severity === severity);

  const blocks: string[][] = [
    [headline(report)],
    section(SEVERITY_HEADING.error, bySeverity("error")),
    section(SEVERITY_HEADING.warning, bySeverity("warning")),
    section(SEVERITY_HEADING.info, bySeverity("info")),
    section("Waived", waived),
  ];

  return blocks
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}
