import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Generate an opaque, URL-safe secret (256 bits of entropy). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * SHA-256 hex of a token, for at-rest storage of secrets we only ever need to
 * *match*, not read back (invitation tokens, GP-116). The token is random and
 * high-entropy, so a plain hash is enough — no per-token salt needed — and the
 * deterministic digest lets us look a token up by its hash.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
