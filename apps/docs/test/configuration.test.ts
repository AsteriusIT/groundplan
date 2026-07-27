import { describe, expect, it } from "vitest";

import { mainText, pageById, repoFile } from "./helpers.js";

/**
 * The configuration reference is checked against the code (GP-218).
 *
 * A hand-copied list of environment variables diverges from the code on the
 * first busy week, and a reference page that is 90% true is worse than none: a
 * reader cannot tell which 10%. So the test reads the API's configuration
 * module — the single place env access is allowed — and requires a documented
 * row for every variable it reads. Adding a variable without documenting it
 * fails the build, which is the point.
 */

const ENV_MODULE = "apps/backend/src/config/env.ts";

/** Every `process.env.X` the configuration module reads. */
function variablesReadByTheBackend(): string[] {
  const source = repoFile(ENV_MODULE);
  const found = new Set<string>();
  for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
    found.add(match[1]!);
  }
  return [...found].sort();
}

/**
 * Variables the page legitimately names that the API never reads: the compose
 * file's own, the database's, the identity provider's. They are documented
 * where the reader meets them, not where the API would.
 */
const NOT_THE_APIS = new Set([
  "POSTGRES_PASSWORD",
  "KC_DB_PASSWORD",
  "KEYCLOAK_ADMIN_PASSWORD",
  "APP_DOMAIN",
  "AUTH_DOMAIN",
  "WWW_DOMAIN",
  "DOCS_DOMAIN",
  "ACME_EMAIL",
  "IMAGE_TAG",
  "GROUNDPLAN_URL",
  "GROUNDPLAN_TOKEN",
]);

describe("configuration reference (GP-218)", () => {
  it("documents every variable the API reads", () => {
    const page = mainText(pageById("reference/configuration").html);
    const undocumented = variablesReadByTheBackend().filter(
      (name) => !page.includes(name),
    );
    expect(
      undocumented,
      `add a row to reference/configuration.md for: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("documents nothing the API stopped reading", () => {
    // The mirror failure: a variable dropped from the code but left on the page
    // sends an operator hunting for an effect that no longer exists.
    const page = mainText(pageById("reference/configuration").html);
    const read = new Set(variablesReadByTheBackend());
    const mentioned = [...page.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)]
      .map((m) => m[1]!)
      .filter((name) => !NOT_THE_APIS.has(name));
    const stale = [...new Set(mentioned)].filter((name) => !read.has(name));
    expect(
      stale,
      `documented but no longer read by the API: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("states the fail-closed rule and the flag posture", () => {
    const page = mainText(pageById("reference/configuration").html);
    expect(page).toMatch(/refuses to boot/i);
    expect(page).toMatch(/AI_API_KEY[\s\S]{0,400}feature flag/i);
    expect(page).toMatch(/SINGLE_ORG[\s\S]{0,800}auto-join/i);
  });
});
