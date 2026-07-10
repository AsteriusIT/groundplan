import type { FastifyPluginAsync } from "fastify";

/**
 * Readiness probe including database connectivity. Returns 200 with
 * `{ status: "ok", db: "ok" }` when Postgres answers, 503 otherwise.
 */
export const healthzRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", async (_request, reply) => {
    try {
      await app.pool.query("SELECT 1");
      return { status: "ok", db: "ok" };
    } catch (err) {
      app.log.error({ err }, "healthz: database unreachable");
      return reply.code(503).send({ status: "error", db: "down" });
    }
  });
};
