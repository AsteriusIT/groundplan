import { randomBytes, timingSafeEqual } from "node:crypto";

/** Generate an opaque, URL-safe secret (256 bits of entropy). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
