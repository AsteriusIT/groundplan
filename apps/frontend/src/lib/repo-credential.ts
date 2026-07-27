/**
 * Which credential will authenticate a repository (GP-231) — the mirror of the
 * backend resolver, for the one thing a form must answer *before* submitting:
 * do we need to ask for a token at all?
 *
 * It mirrors, deliberately, rather than calls: the answer has to change as the
 * user types a URL, and a round trip per keystroke to learn "yes, your app
 * covers acme/" would be a request per character for a fact the browser already
 * holds. The server stays the authority — it re-resolves and refuses on its own
 * terms (GP-229) — so the worst a stale mirror can do is show a token field
 * that turns out to be unnecessary.
 *
 * The matching rule is the backend's: an installation is bound to an account,
 * logins are case-insensitive, and *exactly one* candidate resolves silently.
 * Two candidates is a question, never a guess.
 */
import type { Provider, ProviderConnection } from "@/api/types";

/** The owner segment of a repository URL, lowercased, or null. */
export function ownerOf(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter((s) => s !== "");
  // `owner/name`: an owner with no repository after it is not yet an answer.
  if (segments.length < 2) return null;
  return segments[segments.length - 2]!.toLowerCase();
}

export type CredentialResolution =
  /** Not enough URL to say anything yet. */
  | { kind: "unknown" }
  /** One connection covers it: no token field, and none needed. */
  | { kind: "covered"; connection: ProviderConnection }
  /** Several could: the user picks, because we must not guess. */
  | { kind: "ambiguous"; candidates: ProviderConnection[] }
  /** Nothing covers it: the token path, exactly as before (GP-51/52). */
  | { kind: "token" };

/** Which of this org's connections would authenticate `url`. */
export function resolveCredential(
  url: string,
  provider: Provider,
  connections: ProviderConnection[],
): CredentialResolution {
  const owner = ownerOf(url);
  if (!owner) return { kind: "unknown" };

  const candidates = connections.filter(
    (connection) =>
      connection.provider === provider &&
      connection.config.account?.toLowerCase() === owner,
  );
  if (candidates.length === 1) return { kind: "covered", connection: candidates[0]! };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "token" };
}
