import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { and, desc, eq } from "drizzle-orm";

import {
  clusters,
  graphSnapshots,
  publicSnapshotColumns,
  type ClusterRow,
} from "../db/schema.js";
import { K8sUnreachableError } from "../services/k8s-reader.js";
import {
  generateNamespaceSnapshot,
  K8sGenerationInProgressError,
} from "../services/k8s-snapshots.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

// RFC 1123 label, as Kubernetes itself defines a namespace name. Anything else
// cannot name a namespace, so it never becomes a request to a cluster.
const NAMESPACE_PATTERN = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const namespaceParamsSchema = {
  type: "object",
  required: ["id", "ns"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    ns: { type: "string", minLength: 1, maxLength: 63, pattern: NAMESPACE_PATTERN },
  },
};

async function loadCluster(
  app: FastifyInstance,
  id: string,
): Promise<ClusterRow | undefined> {
  const [row] = await app.db.select().from(clusters).where(eq(clusters.id, id));
  return row;
}

/**
 * A cluster we could not read is a 502 — the failure is upstream, not in the
 * request. The body carries the *kind* and a message we wrote: the cluster's own
 * error can quote the server URL back at us, and a kubeconfig's contents must not
 * reach a response body or a log line by any route.
 */
function unreachable(reply: FastifyReply, err: K8sUnreachableError) {
  return reply.code(502).send({
    error: "Bad Gateway",
    message: "could not read the cluster — check its connection and try again",
    kind: err.kind,
  });
}

/**
 * The Kubernetes live view's API (GP-97): list namespaces, generate a snapshot of
 * one, browse its history. The snapshots are ordinary snapshots, so `GET
 * /snapshots/:id`, its stats and its exports keep working with no change at all.
 */
export const k8sSnapshotRoutes: FastifyPluginAsync = async (app) => {
  // Live list, straight from the cluster. Names only — nothing is stored.
  app.get(
    "/clusters/:id/namespaces",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const cluster = await loadCluster(app, id);
      if (!cluster) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "cluster not found" });
      }

      try {
        const kubeconfig = app.encryptor.decrypt(cluster.kubeconfig);
        return { namespaces: await app.k8s.listNamespaces(kubeconfig) };
      } catch (err) {
        if (err instanceof K8sUnreachableError) return unreachable(reply, err);
        // A kubeconfig we can no longer decrypt is as unusable as one we cannot
        // reach, and it is not the caller's mistake to explain.
        app.log.error({ clusterId: id }, "could not read cluster namespaces");
        return unreachable(reply, new K8sUnreachableError("invalid_config"));
      }
    },
  );

  // Read the namespace, map it, store it (GP-96/GP-97).
  app.post(
    "/clusters/:id/namespaces/:ns/snapshots",
    { schema: { params: namespaceParamsSchema } },
    async (request, reply) => {
      const { id, ns } = request.params as { id: string; ns: string };
      const cluster = await loadCluster(app, id);
      if (!cluster) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "cluster not found" });
      }

      try {
        const snapshot = await generateNamespaceSnapshot(app, cluster, ns);
        return reply.code(201).send(snapshot);
      } catch (err) {
        if (err instanceof K8sGenerationInProgressError) {
          return reply.code(409).send({ error: "Conflict", message: err.message });
        }
        if (err instanceof K8sUnreachableError) return unreachable(reply, err);
        throw err;
      }
    },
  );

  // History for one namespace — metadata + stats, never the graph body (GP-26).
  app.get(
    "/clusters/:id/namespaces/:ns/snapshots",
    { schema: { params: namespaceParamsSchema } },
    async (request, reply) => {
      const { id, ns } = request.params as { id: string; ns: string };
      const cluster = await loadCluster(app, id);
      if (!cluster) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "cluster not found" });
      }

      return app.db
        .select(publicSnapshotColumns)
        .from(graphSnapshots)
        .where(
          and(
            eq(graphSnapshots.clusterId, id),
            eq(graphSnapshots.namespace, ns),
          ),
        )
        .orderBy(desc(graphSnapshots.createdAt));
    },
  );
};
