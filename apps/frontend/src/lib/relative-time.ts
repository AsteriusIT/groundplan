/**
 * "3 hours ago", in the coarsest unit that is still true.
 *
 * Shared by every surface that has to date a measurement rather than present it
 * as current — the drift banner (GP-207) and the reality comparison (GP-209).
 * Both exist because a snapshot read as live is the failure mode of this whole
 * epic, so the sentence that prevents it is written once.
 */

/** How long a unit lasts in seconds, and how long it stays the right one. */
const UNITS: { noun: string; seconds: number; until: number }[] = [
  { noun: "second", seconds: 1, until: 60 },
  { noun: "minute", seconds: 60, until: 3600 },
  { noun: "hour", seconds: 3600, until: 86400 },
  { noun: "day", seconds: 86400, until: 2592000 },
];

/**
 * Past a month it stops counting: the exact age of a very old measurement is not
 * the point — that nobody has re-run it is.
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "at an unknown time";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));

  for (const unit of UNITS) {
    if (seconds >= unit.until) continue;
    const value = Math.floor(seconds / unit.seconds);
    if (value <= 0) return "just now";
    return `${value} ${unit.noun}${value === 1 ? "" : "s"} ago`;
  }
  return "over a month ago";
}
