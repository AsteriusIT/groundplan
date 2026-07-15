/** Turn a project name into a URL-safe slug the backend will accept. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|(?<!-)-+$/g, "");
}

/** Up to two initials for an avatar, from a display name or email. */
export function initials(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]);
  return (letters.join("") || source[0] || "?").toUpperCase();
}

/** Reduce a git remote URL to its `owner/repo` path (best effort). */
export function repoName(url: string): string {
  const clean = (p: string) =>
    p.replace(/\.git$/, "").replace(/^\/+/, "").replace(/(?<!\/)\/+$/, "");

  // scp-like syntax: git@host:owner/repo(.git) — path is after the colon.
  const scp = /^[^/@]+@[^:/]+:(.+)$/.exec(url.trim());
  if (scp) return clean(scp[1] as string) || url;

  // Otherwise strip a scheme (https://) then the host, leaving owner/repo.
  const withoutScheme = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = withoutScheme.indexOf("/");
  const path = slash === -1 ? withoutScheme : withoutScheme.slice(slash + 1);
  return clean(path) || url;
}

/** The branch a git ref names: `refs/heads/feature-x` → `feature-x`. */
export function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/** The first 8 characters of a commit sha — what we show everywhere. */
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** Human-friendly date from an ISO string, e.g. "10 Jul 2026". */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * How long ago an instant was, e.g. "14 min ago" — for freshness signals where
 * the age is the point ("is my CI still sending data?"). Past a month the age
 * stops meaning anything and we fall back to the date.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  // Clamp: a server clock a few seconds ahead of ours must not read "-3 min ago".
  const elapsed = Math.max(0, now.getTime() - date.getTime());

  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), "hour");
  if (elapsed < 30 * DAY) return plural(Math.floor(elapsed / DAY), "day");
  return formatDate(iso);
}
