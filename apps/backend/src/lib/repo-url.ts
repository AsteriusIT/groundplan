/**
 * Comparing repository URLs (GP-227/229).
 *
 * The same repository reaches us spelled a dozen ways: with and without `.git`,
 * with a trailing slash, `HTTPS://GitHub.com/Acme/Infra`, or carrying a token in
 * the userinfo of a URL someone pasted out of a CI log. Every one of those is
 * the same remote, and two facts depend on knowing that:
 *
 *  - whether a discovered repository is *already imported* (GP-227), and
 *  - whether an import is a duplicate or a legitimate second attachment of a
 *    monorepo (GP-229), where the key is `(org, url, kind, path)`.
 *
 * So normalization is a comparison key, not a stored value: we keep the URL the
 * user gave us — it is what they will recognise in the list — and compare on
 * this. The host is lowercased because DNS is case-insensitive; the path is not,
 * because `acme/Infra` and `acme/infra` are two different repositories on GitHub
 * and pretending otherwise would silently merge them.
 *
 * The owner half *is* compared case-insensitively, but only where a ticket asks
 * for it explicitly (matching an installation's account), which is why that is a
 * separate function rather than a quality of the key.
 */

/** Strip a token/user out of `https://user:token@host/...` before comparing. */
function stripUserInfo(url: URL): void {
  url.username = "";
  url.password = "";
}

/**
 * A stable comparison key for a repository URL, or the trimmed input when it is
 * not a URL we can parse (a bare `owner/repo`, an ssh remote). Returning the
 * input rather than null keeps callers honest: two identical unparseable
 * strings still compare equal, which is the least surprising behaviour.
 */
export function repoUrlKey(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");
  }

  stripUserInfo(url);
  // Query and fragment are never part of a clone target.
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/** Do these two URLs address the same repository? */
export function sameRepoUrl(a: string, b: string): boolean {
  return repoUrlKey(a) === repoUrlKey(b);
}

/**
 * The `owner/name` a URL points at, or null. Used to ask an installation
 * whether it covers a repository someone typed by hand (GP-229) — GitHub logins
 * are case-insensitive, so the owner is lowercased and the name is not.
 */
export function parseOwnerRepo(
  input: string,
): { owner: string; name: string } | null {
  const key = repoUrlKey(input);
  if (key === "") return null;
  const path = key.includes("://") ? (key.split("://")[1] ?? "") : key;
  const segments = path.split("/").filter((s) => s !== "");
  // `host/owner/name` for a URL, `owner/name` for a bare full name.
  const tail = key.includes("://") ? segments.slice(1) : segments;
  if (tail.length < 2) return null;
  const name = tail[tail.length - 1]!;
  const owner = tail[tail.length - 2]!;
  return { owner: owner.toLowerCase(), name };
}
