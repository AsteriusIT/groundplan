import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import type { Pool } from "pg";

import type { AppEnv } from "./config/env.js";
import { dbPlugin } from "./plugins/db.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { healthRoutes } from "./routes/health.js";
import { healthzRoutes } from "./routes/healthz.js";
import { projectRoutes } from "./routes/projects.js";
import { repositoryFileRoutes } from "./routes/repository-files.js";
import { repositoryRoutes } from "./routes/repositories.js";

export type BuildAppOptions = {
  /** Inject a Postgres pool (e.g. a stub in tests). Defaults to a real pool. */
  pool?: Pool;
};

/** Pretty logs in dev, structured JSON in prod, silent in tests. */
function resolveLogger(env: AppEnv) {
  if (env.nodeEnv === "test") return false;
  if (env.nodeEnv === "development") {
    return { transport: { target: "pino-pretty" } };
  }
  return true;
}

/**
 * Build a fully-configured Fastify instance without starting it.
 * Keeping construction separate from `listen()` makes the app easy to test.
 */
export async function buildApp(
  env: AppEnv,
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: resolveLogger(env),
    // Report every validation error (not just the first) so the 422 response
    // can list all offending fields.
    ajv: { customOptions: { allErrors: true } },
  });

  registerErrorHandler(app);

  await app.register(cors, {
    origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(","),
  });
  await app.register(sensible);
  await app.register(dbPlugin, { databaseUrl: env.databaseUrl, pool: opts.pool });

  // Readiness probe (with DB check) at the conventional root path.
  await app.register(healthzRoutes);
  // Versioned API routes.
  await app.register(healthRoutes, { prefix: "/api/v1" });
  await app.register(projectRoutes, { prefix: "/api/v1" });
  await app.register(repositoryRoutes, { prefix: "/api/v1" });
  await app.register(repositoryFileRoutes, { prefix: "/api/v1" });

  return app;
}
