/**
 * How a CI job proves it may push to a repository (GP-5, GP-206).
 *
 * A pipeline has no bearer token — it has a secret we gave it — so the ingestion
 * endpoints are auth-exempt and authenticate here instead. Two tokens are
 * accepted: the repository's own, and the app-wide one when a deployment set it,
 * so an estate can share one CI secret. Comparison is constant-time.
 *
 * Stated once, here, because there is now more than one thing CI can push: a
 * plan, rendered manifests, a drift measurement (GP-206), a reality snapshot
 * (GP-208). They all answer to the same secret, and a second copy of this check
 * is a second place for it to drift out of step.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { safeEqual } from "../lib/tokens.js";
import { getAppWebhookToken } from "./app-settings.js";

/** The `X-Groundplan-Token` header value, whatever shape Fastify handed it in. */
export function tokenFromHeader(
  header: string | string[] | undefined,
): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

/** True when this token may push to this repository. */
export async function ciTokenAuthorized(
  db: NodePgDatabase,
  provided: string | undefined,
  repo: { webhookToken: string },
): Promise<boolean> {
  if (!provided) return false;
  if (safeEqual(provided, repo.webhookToken)) return true;
  const appToken = await getAppWebhookToken(db);
  return appToken !== null && safeEqual(provided, appToken);
}
