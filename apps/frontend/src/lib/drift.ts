/**
 * Turning a drift measurement into what the canvas and the panels need (GP-207).
 *
 * One rule governs everything here: **a stale measurement marks nothing.** It
 * was taken against a sha nobody is looking at, so badging today's diagram from
 * it would put confident marks on the wrong resources — the single failure the
 * whole epic is built to avoid. The freshness banner says so instead, and the
 * canvas stays clean.
 */
import type { AttributeDiffRow, DriftState, PolicyStatus } from "@/api/types";

/** Is this measurement about the diagram currently on screen? */
function usable(drift: DriftState | null): drift is DriftState {
  return drift !== null && !drift.stale;
}

/**
 * Node id → what drifted about it, for the canvas mark's tooltip. Names the
 * attributes rather than counting them: "min_tls_version, allow_blob_public_access
 * changed" tells a reader whether to care; "3 attributes changed" does not.
 */
export function driftLabels(drift: DriftState | null): Map<string, string> {
  const labels = new Map<string, string>();
  if (!usable(drift)) return labels;
  for (const resource of drift.report.resources) {
    if (resource.change === "delete") {
      labels.set(resource.address, "Drifted — this resource no longer exists");
      continue;
    }
    labels.set(resource.address, updateLabel(resource.attribute_diff));
  }
  return labels;
}

/** How many attribute names the mark's tooltip lists before it counts the rest. */
const NAMED_ATTRS = 3;

function updateLabel(rows: AttributeDiffRow[]): string {
  if (rows.length === 0) return "Drifted — changed outside Terraform";
  const keys = rows.map((row) => row.key);
  const named = keys.slice(0, NAMED_ATTRS).join(", ");
  const rest = keys.length - NAMED_ATTRS;
  const more = rest > 0 ? ` and ${rest} more` : "";
  return `Drifted outside Terraform — ${named}${more}`;
}

/** Node id → the masked before→after rows, for the node's detail panel. */
export function driftRowsByNode(
  drift: DriftState | null,
): Map<string, AttributeDiffRow[]> {
  const rows = new Map<string, AttributeDiffRow[]>();
  if (!usable(drift)) return rows;
  for (const resource of drift.report.resources) {
    if (resource.attribute_diff.length > 0) {
      rows.set(resource.address, resource.attribute_diff);
    }
  }
  return rows;
}

/**
 * The resources carrying a violation that exists in the cloud but not in the
 * code (GP-207) — introduced outside IaC. The strongest signal in the report:
 * nobody reviewed it, because there was nothing to review.
 */
export function outsideIacAddresses(drift: DriftState | null): Set<string> {
  if (!usable(drift)) return new Set();
  return new Set((drift.report.policy?.added ?? []).map((v) => v.address));
}

/** The verdict the outside-IaC violations amount to, or null when none/uncomputed. */
export function outsideIacStatus(drift: DriftState | null): PolicyStatus | null {
  if (!usable(drift)) return null;
  const policy = drift.report.policy;
  if (!policy || policy.added.length === 0) return null;
  return policy.status;
}

export type DriftFreshness = {
  /** `stale` = main moved; `unanchored` = main has no diagram to line up with. */
  tone: "fresh" | "stale" | "unanchored";
  text: string;
};

const short = (sha: string): string => sha.slice(0, 7);

/**
 * What the banner says. Every state names a sha, because "measured 3 hours ago"
 * without saying *of what* is the sentence that lets somebody act on drift
 * against code that has already changed.
 */
export function driftFreshness(drift: DriftState): DriftFreshness {
  const when = relative(drift.measuredAt);
  if (drift.stale && drift.baseCommitSha) {
    return {
      tone: "stale",
      text: `Measured ${when} against ${short(drift.commitSha)} — ${drift.ref} has since moved to ${short(drift.baseCommitSha)}. Re-measure before acting on this.`,
    };
  }
  if (drift.snapshotId === null) {
    return {
      tone: "unanchored",
      text: `Measured ${when} against ${short(drift.commitSha)} — there is no documentation of ${drift.ref} at that commit to line it up with.`,
    };
  }
  // Provenance only. What the measurement *found* is the panel's to say — a
  // banner that also reports the finding means two places to keep in step.
  return {
    tone: "fresh",
    text: `Measured ${when} against ${short(drift.commitSha)}.`,
  };
}

/** How long a unit lasts in seconds, and how long it stays the right one. */
const AGO_UNITS: { noun: string; seconds: number; until: number }[] = [
  { noun: "second", seconds: 1, until: 60 },
  { noun: "minute", seconds: 60, until: 3600 },
  { noun: "hour", seconds: 3600, until: 86400 },
  { noun: "day", seconds: 86400, until: 2592000 },
];

/**
 * "3 hours ago", in the coarsest unit that is still true. Past a month it stops
 * counting: the exact age of a very old measurement is not the point — that
 * nobody has re-run it is.
 */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "at an unknown time";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));

  for (const unit of AGO_UNITS) {
    if (seconds >= unit.until) continue;
    const value = Math.floor(seconds / unit.seconds);
    if (value <= 0) return "just now";
    return `${value} ${unit.noun}${value === 1 ? "" : "s"} ago`;
  }
  return "over a month ago";
}
