import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import {
  confluenceConnections,
  type ConfluenceConnectionRow,
} from "../db/schema.js";
import type { ConfluenceVerifyResult } from "./confluence.js";

/**
 * Decrypt the stored credential, check the space is reachable with it, and
 * persist the outcome (connection_status + verified_at) — `verifyAndStore`
 * (GP-11) for Confluence, down to the shape of its return.
 *
 * A failed check is a stored `failed`, never a thrown error; and note what is
 * NOT logged: the plaintext, the ciphertext, and anything the instance said.
 */
export async function verifyConfluenceAndStore(
  app: FastifyInstance,
  connection: ConfluenceConnectionRow,
): Promise<{ connection: ConfluenceConnectionRow; result: ConfluenceVerifyResult }> {
  let result: ConfluenceVerifyResult;
  try {
    const credential = app.encryptor.decrypt(connection.credential);
    result = await app.confluence.verifySpace(
      {
        baseUrl: connection.baseUrl,
        authType: connection.authType,
        email: connection.email,
        credential,
      },
      connection.spaceKey,
    );
  } catch {
    app.log.warn(
      { connectionId: connection.id },
      "could not decrypt stored Confluence credential",
    );
    result = { ok: false, error: "auth_failed" };
  }

  const [row] = await app.db
    .update(confluenceConnections)
    .set({
      connectionStatus: result.ok ? "ok" : "failed",
      verifiedAt: new Date(),
    })
    .where(eq(confluenceConnections.id, connection.id))
    .returning();

  return { connection: row ?? connection, result };
}
