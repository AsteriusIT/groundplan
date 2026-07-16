/**
 * Postgres error helpers. Drizzle wraps the driver error, so the original `pg`
 * error (which carries `code`) can be nested under `.cause` — walk the chain.
 */

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: string }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
