import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";

import type { AppEnv } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";

/**
 * Build a fully-configured Fastify instance without starting it.
 * Keeping construction separate from `listen()` makes the app easy to test.
 */
export async function buildApp(env: AppEnv): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.nodeEnv === "development"
        ? { transport: { target: "pino-pretty" } }
        : true,
  });

  await app.register(cors, {
    origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(","),
  });
  await app.register(sensible);

  // Register API routes under a versioned prefix.
  await app.register(healthRoutes, { prefix: "/api/v1" });

  return app;
}
