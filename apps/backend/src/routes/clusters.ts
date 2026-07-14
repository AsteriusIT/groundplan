import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { desc, eq } from "drizzle-orm";

import { clusters, projects, toPublicCluster, type ClusterRow } from "../db/schema.js";
import { InvalidKubeconfigError, parseKubeconfig } from "../lib/kubeconfig.js";
import { verifyClusterAndStore } from "../services/cluster-verification.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

// A kubeconfig with embedded certs is comfortably under 64 KB; anything larger is
// not a kubeconfig, and the shape check below would reject it anyway.
const KUBECONFIG_MAX = 64000;

const createClusterSchema = {
  type: "object",
  required: ["name", "kubeconfig"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    // Write-only: accepted here, never echoed back in any response.
    kubeconfig: { type: "string", minLength: 1, maxLength: KUBECONFIG_MAX },
  },
};

const updateClusterSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    /** Replace-only: a new kubeconfig overwrites the old one and re-verifies. */
    kubeconfig: { type: "string", minLength: 1, maxLength: KUBECONFIG_MAX },
  },
};

async function loadCluster(
  app: FastifyInstance,
  id: string,
): Promise<ClusterRow | undefined> {
  const [row] = await app.db.select().from(clusters).where(eq(clusters.id, id));
  return row;
}

function notFound(reply: FastifyReply, what: "cluster" | "project") {
  return reply.code(404).send({ error: "Not Found", message: `${what} not found` });
}

/**
 * The kubeconfig's shape is checked before anything is written: garbage is a 422
 * the user can fix, never a row that fails mysteriously at read time. The message
 * comes from `InvalidKubeconfigError`, which never quotes the file — a validation
 * error that echoes back a credential is a credential in a log.
 */
function rejectMalformed(reply: FastifyReply, err: unknown) {
  if (err instanceof InvalidKubeconfigError) {
    return reply.code(422).send({
      error: "Unprocessable Entity",
      message: err.message,
      fields: [{ field: "kubeconfig", message: err.message }],
    });
  }
  throw err;
}

/**
 * Clusters (GP-95): a project's Kubernetes clusters, attached with a write-only,
 * encrypted kubeconfig. Every read goes through `toPublicCluster`, so no response
 * can leak one by omission.
 *
 * Protected by the global auth hook — nothing to wire here.
 */
export const clusterRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/projects/:id/clusters",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, id));
      if (!project) return notFound(reply, "project");

      const rows = await app.db
        .select()
        .from(clusters)
        .where(eq(clusters.projectId, id))
        .orderBy(desc(clusters.createdAt));
      return rows.map(toPublicCluster);
    },
  );

  app.post(
    "/projects/:id/clusters",
    { schema: { params: idParamsSchema, body: createClusterSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { name: string; kubeconfig: string };

      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, id));
      if (!project) return notFound(reply, "project");

      try {
        parseKubeconfig(body.kubeconfig);
      } catch (err) {
        return rejectMalformed(reply, err);
      }

      const [inserted] = await app.db
        .insert(clusters)
        .values({
          projectId: id,
          name: body.name,
          kubeconfig: app.encryptor.encrypt(body.kubeconfig),
        })
        .returning();

      // Attaching a cluster is a claim that we can read it — so we check, at once
      // (the repository rule, GP-11). An unreachable cluster is still attached,
      // and says so.
      const { cluster } = await verifyClusterAndStore(app, inserted!);
      return reply.code(201).send(toPublicCluster(cluster));
    },
  );

  app.get(
    "/clusters/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const cluster = await loadCluster(app, id);
      if (!cluster) return notFound(reply, "cluster");
      return toPublicCluster(cluster);
    },
  );

  app.patch(
    "/clusters/:id",
    { schema: { params: idParamsSchema, body: updateClusterSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; kubeconfig?: string };

      const existing = await loadCluster(app, id);
      if (!existing) return notFound(reply, "cluster");

      const replacingCredentials = body.kubeconfig !== undefined;
      if (replacingCredentials) {
        try {
          parseKubeconfig(body.kubeconfig as string);
        } catch (err) {
          return rejectMalformed(reply, err);
        }
      }

      const [updated] = await app.db
        .update(clusters)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(replacingCredentials
            ? { kubeconfig: app.encryptor.encrypt(body.kubeconfig as string) }
            : {}),
        })
        .where(eq(clusters.id, id))
        .returning();

      let row = updated ?? existing;
      // Only a new credential is a new connection — renaming a cluster says
      // nothing about whether we can reach it.
      if (replacingCredentials) {
        row = (await verifyClusterAndStore(app, row)).cluster;
      }
      return toPublicCluster(row);
    },
  );

  // Check the connection with the stored kubeconfig, on demand.
  app.post(
    "/clusters/:id/verify",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const cluster = await loadCluster(app, id);
      if (!cluster) return notFound(reply, "cluster");

      const { result } = await verifyClusterAndStore(app, cluster);
      if (result.ok) return { ok: true, version: result.version };
      return { ok: false, error: result.error };
    },
  );

  app.delete(
    "/clusters/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await app.db
        .delete(clusters)
        .where(eq(clusters.id, id))
        .returning({ id: clusters.id });
      if (deleted.length === 0) return notFound(reply, "cluster");
      return reply.code(204).send();
    },
  );
};
