import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { repositories, type RepositoryRow } from "../db/schema.js";
import { repositoryAccessToken } from "../integrations/credentials.js";
import type { CredentialMode } from "../integrations/types.js";
import type { VerifyResult } from "./repo-files.js";

/**
 * Obtain the repository's token through the credential strategy (GP-192), run a
 * connection check, and persist the outcome (connection_status + verified_at).
 *
 * A credential that cannot produce a token at all (revoked installation,
 * rejected refresh token) is an `auth_failed` verify — which is exactly what the
 * user needs to see — rather than an exception out of a settings request.
 */
export async function verifyAndStore(
  app: FastifyInstance,
  repo: RepositoryRow,
): Promise<{ repository: RepositoryRow; result: VerifyResult }> {
  let accessToken: string | null = null;
  let credentialMode: CredentialMode | undefined;
  let credentialFailed = false;
  try {
    const credential = await repositoryAccessToken(app, repo);
    accessToken = credential?.token ?? null;
    credentialMode = credential?.mode;
  } catch (err) {
    app.log.warn({ err, repositoryId: repo.id }, "could not obtain a repository token");
    credentialFailed = true;
  }

  const result: VerifyResult = credentialFailed
    ? { ok: false, error: "auth_failed" }
    : await app.verifyConnection({
        url: repo.url,
        provider: repo.provider,
        ref: repo.defaultBranch,
        accessToken,
        credentialMode,
      });

  const [repository] = await app.db
    .update(repositories)
    .set({
      connectionStatus: result.ok ? "ok" : "failed",
      verifiedAt: new Date(),
    })
    .where(eq(repositories.id, repo.id))
    .returning();

  return { repository: repository ?? repo, result };
}
