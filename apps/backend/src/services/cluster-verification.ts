import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { clusters, type ClusterRow } from "../db/schema.js";
import type { K8sVerifyResult } from "./k8s-verify.js";

/**
 * Decrypt the stored kubeconfig, check the cluster is reachable, and persist the
 * outcome (connection_status + verified_at) — `verifyAndStore` (GP-11) for
 * clusters, down to the shape of its return.
 *
 * An unreachable cluster is a stored `failed`, never a thrown error: "we tried
 * and could not get in" is a fact about the cluster, and the row is where a fact
 * about the cluster belongs.
 */
export async function verifyClusterAndStore(
  app: FastifyInstance,
  cluster: ClusterRow,
): Promise<{ cluster: ClusterRow; result: K8sVerifyResult }> {
  let result: K8sVerifyResult;
  try {
    // Note what is NOT logged here: the plaintext, the ciphertext, and the error
    // the client threw (which can carry the server URL). Only the outcome.
    const kubeconfig = app.encryptor.decrypt(cluster.kubeconfig);
    result = await app.k8sVerify(kubeconfig);
  } catch {
    app.log.warn({ clusterId: cluster.id }, "could not decrypt stored kubeconfig");
    result = { ok: false, error: "invalid_config" };
  }

  const [row] = await app.db
    .update(clusters)
    .set({
      connectionStatus: result.ok ? "ok" : "failed",
      verifiedAt: new Date(),
    })
    .where(eq(clusters.id, cluster.id))
    .returning();

  return { cluster: row ?? cluster, result };
}
