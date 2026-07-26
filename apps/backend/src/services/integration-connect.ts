/**
 * Completing an integration's OAuth grant (GP-197).
 *
 * It lives beside the routes rather than in one of them because there is a
 * single callback URL: every provider — git or otherwise — sends the browser
 * back to `/integrations/callback`, which posts to one endpoint. That endpoint
 * reads the sealed state and dispatches here when the flow belongs to an
 * *integration* (an Atlassian site) rather than a git provider connection.
 *
 * One callback, one page, one client call: the alternative was a second
 * redirect URI to register, document and get wrong.
 */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import {
  integrations,
  integrationType,
  toPublicIntegration,
  type IntegrationConfig,
  type PublicIntegration,
} from "../db/schema.js";
import { atlassianConnectFlow, cloudApiBase } from "../integrations/atlassian.js";
import type { ConnectState } from "../integrations/connect-state.js";
import type { ConnectFlow } from "../integrations/types.js";

export type IntegrationTypeName = (typeof integrationType.enumValues)[number];

/**
 * The connect flow this instance can run for an integration *type*. Keyed by
 * `integration_type`, so a future Slack or Jira integration registers a flow
 * and inherits the routes — the provider registry's trick, one level up.
 */
export function integrationFlow(
  app: FastifyInstance,
  type: IntegrationTypeName,
): ConnectFlow | null {
  if (type === "atlassian" && app.integrations.atlassianOAuth) {
    return atlassianConnectFlow(app.integrations.atlassianOAuth, app.oauth2Http);
  }
  return null;
}

/** Does this sealed state belong to an integration flow rather than a git one? */
export function integrationTypeOf(
  state: ConnectState,
): IntegrationTypeName | null {
  const raw = state.carry["integrationType"];
  return integrationType.enumValues.includes(raw as IntegrationTypeName)
    ? (raw as IntegrationTypeName)
    : null;
}

export type CompleteResult =
  | { ok: true; integration: PublicIntegration; created: boolean }
  | { ok: false; message: string };

/**
 * Store (or replace) the org's Integration for the site that was just
 * authorized. Replacing **in place** is the requirement that matters: the repo
 * targets point at the integration id, so keeping it is what makes already
 * published pages update rather than being recreated after the move to OAuth.
 */
export async function completeIntegrationOAuth(
  app: FastifyInstance,
  orgId: string,
  state: ConnectState,
  params: Record<string, string>,
): Promise<CompleteResult> {
  const type = integrationTypeOf(state);
  const flow = type ? integrationFlow(app, type) : null;
  if (!type || !flow) {
    return { ok: false, message: "this connection attempt is not usable here" };
  }

  let connection;
  try {
    connection = await flow.complete({
      params,
      carry: state.carry,
      redirectUri: `${app.integrations.publicBaseUrl}/integrations/callback`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    app.log.warn({ err, type }, "integration connect flow failed");
    return { ok: false, message };
  }

  const cloudId = connection.config.cloudId ?? null;
  const siteUrl = connection.config.instanceUrl ?? null;
  const config: IntegrationConfig = {
    // A 3LO token authenticates against the gateway, never the site's own host.
    baseUrl: cloudId ? cloudApiBase(cloudId) : "",
    authType: "oauth",
    email: null,
    cloudId,
    siteUrl,
  };

  const existing = (
    await app.db
      .select()
      .from(integrations)
      .where(
        and(eq(integrations.organizationId, orgId), eq(integrations.type, type)),
      )
  ).find((row) => row.config.cloudId === cloudId);

  const values = {
    organizationId: orgId,
    type,
    name: connection.name,
    config,
    credential: app.encryptor.encrypt(connection.secret ?? ""),
    connectionStatus: "ok" as const,
    lastError: null,
    verifiedAt: new Date(),
  };

  const [row] = existing
    ? await app.db
        .update(integrations)
        .set(values)
        .where(eq(integrations.id, existing.id))
        .returning()
    : await app.db.insert(integrations).values(values).returning();

  return {
    ok: true,
    integration: toPublicIntegration(row!),
    created: !existing,
  };
}
