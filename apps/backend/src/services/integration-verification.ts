import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { integrations, type IntegrationRow } from "../db/schema.js";
import type { ConfluenceVerifyResult } from "./confluence.js";

/**
 * Decrypt an org Integration's stored credential, check it reaches its instance,
 * and persist the outcome (connection_status + verified_at) — `verifyAndStore`
 * (GP-11) for an org-level Integration (GP-183).
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
    const credential = app.encryptor.decrypt(integration.credential);
    result = await app.confluence.verifyCredential({
      baseUrl: integration.config.baseUrl,
      authType: integration.config.authType,
      email: integration.config.email,
      credential,
    });
  } catch {
    app.log.warn(
      { integrationId: integration.id },
      "could not decrypt stored integration credential",
    );
    result = { ok: false, error: "auth_failed" };
  }

  const [row] = await app.db
    .update(integrations)
    .set({
      connectionStatus: result.ok ? "ok" : "failed",
      verifiedAt: new Date(),
    })
    .where(eq(integrations.id, integration.id))
    .returning();

  return { integration: row ?? integration, result };
}
