import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { integrations, type IntegrationRow } from "../db/schema.js";
import { atlassianCredential } from "../integrations/atlassian.js";
import type { ConfluenceVerifyResult } from "./confluence.js";

/**
 * Decrypt an org Integration's stored credential, check it reaches its instance,
 * and persist the outcome (connection_status + verified_at) — `verifyAndStore`
 * (GP-11) for an org-level Integration (GP-183).
 *
 * The credential itself comes from `atlassianCredential` (GP-197): a stored API
 * token or PAT, or an access token minted from the OAuth grant right now — so a
 * verify on an OAuth integration is also the check that the grant still works.
 *
 * It proves credential + base URL only; which space a repository publishes to is
 * a repo-level target, checked at publish. So a bad credential is `auth_failed`
 * and an unreachable / wrong base URL is `network` — the two the verify endpoint
 * must tell apart. A failed check is a stored `failed`, never a thrown error, and
 * the plaintext, the ciphertext and anything the instance said are never logged.
 */
export async function verifyIntegrationAndStore(
  app: FastifyInstance,
  integration: IntegrationRow,
): Promise<{ integration: IntegrationRow; result: ConfluenceVerifyResult }> {
  let result: ConfluenceVerifyResult;
  try {
    const credential = await atlassianCredential(app, integration);
    result = await app.confluence.verifyCredential({
      baseUrl: integration.config.baseUrl,
      authType: integration.config.authType,
      email: integration.config.email,
      credential,
    });
  } catch (err) {
    // A credential we cannot read *or renew* is an auth failure the user must
    // act on; the message says which, without ever quoting the credential.
    app.log.warn(
      { err, integrationId: integration.id },
      "could not obtain a credential for this integration",
    );
    result = { ok: false, error: "auth_failed" };
  }

  const [row] = await app.db
    .update(integrations)
    .set({
      connectionStatus: result.ok ? "ok" : "failed",
      lastError: result.ok ? null : errorMessage(result),
      verifiedAt: new Date(),
    })
    .where(eq(integrations.id, integration.id))
    .returning();

  return { integration: row ?? integration, result };
}

/** A short, credential-free reason for the UI. */
function errorMessage(result: ConfluenceVerifyResult): string {
  if (result.ok) return "";
  if (result.error === "auth_failed") {
    return "the credential was refused — reconnect this integration";
  }
  if (result.error === "space_not_found") return "the space was not found";
  return "the instance could not be reached";
}
