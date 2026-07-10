import type { FastifyPluginAsync } from "fastify";

/**
 * Liveness/readiness endpoint. Kept trivial for now — the platform is
 * "empty" until v1 wiring (repo connection, plan ingestion) lands.
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => {
    return {
      status: "ok",
      service: "groundplan-backend",
      uptime: process.uptime(),
    };
  });
};
