import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { repositories, type RepositoryRow } from "../db/schema.js";
import type { VerifyResult } from "./repo-files.js";

/**
 * Decrypt the stored PAT, run a connection check, and persist the outcome
 * (connection_status + verified_at) on the repository.
 */
export async function verifyAndStore(
  app: FastifyInstance,
  repo: RepositoryRow,
): Promise<{ repository: RepositoryRow; result: VerifyResult }> {
  let accessToken: string | null = null;
  if (repo.accessToken) {
    try {
      accessToken = app.encryptor.decrypt(repo.accessToken);
    } catch (err) {
      app.log.warn({ err, repositoryId: repo.id }, "could not decrypt stored PAT");
    }
  }

  const result = await app.verifyConnection({
    url: repo.url,
    provider: repo.provider,
    ref: repo.defaultBranch,
    accessToken,
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
