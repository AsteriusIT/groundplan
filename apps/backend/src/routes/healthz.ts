import type { FastifyPluginAsync } from "fastify";

/**
 * Kubernetes-style probe pair (GP-168):
 *
 * - `GET /healthz` — liveness. Answers 200 whenever the process is up. It
 *   deliberately ignores the database: restarting the pod does not fix an
 *   unreachable Postgres, so a DB outage must not put the API in a restart loop.
 * - `GET /readyz` — readiness. 200 with `{ status: "ok", db: "ok" }` when
 *   Postgres answers, 503 otherwise, so traffic is held back until the app can
 *   actually serve it.
 */
export const healthzRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await app.pool.query("SELECT 1");
      return { status: "ok", db: "ok" };
    } catch (err) {
      app.log.error({ err }, "readyz: database unreachable");
      return reply.code(503).send({ status: "error", db: "down" });
    }
  });
};
