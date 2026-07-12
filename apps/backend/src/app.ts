import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import type { JWTVerifyGetKey } from "jose";
import type { Pool } from "pg";

import type { AppEnv } from "./config/env.js";
import { createEncryptor, type Encryptor } from "./lib/encryption.js";
import { realGitHubClient, type GitHubClient } from "./services/github.js";
import { realGitLabClient, type GitLabClient } from "./services/gitlab.js";
import { authPlugin } from "./plugins/auth.js";
import { backgroundPlugin } from "./plugins/background.js";
import { dbPlugin } from "./plugins/db.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import {
  verifyConnection as realVerifyConnection,
  type RepoSource,
  type VerifyResult,
} from "./services/repo-files.js";
import { docsRoutes } from "./routes/docs.js";
import { exportRoutes } from "./routes/exports.js";
import { healthRoutes } from "./routes/health.js";
import { healthzRoutes } from "./routes/healthz.js";
import { ingestionRoutes } from "./routes/ingestion.js";
import { meRoutes } from "./routes/me.js";
import { projectRoutes } from "./routes/projects.js";
import { pullRoutes } from "./routes/pulls.js";
import { repositoryFileRoutes } from "./routes/repository-files.js";
import { repositoryRoutes } from "./routes/repositories.js";
import { shareRoutes } from "./routes/share-links.js";
import { snapshotRoutes } from "./routes/snapshots.js";

export type VerifyConnection = (source: RepoSource) => Promise<VerifyResult>;

declare module "fastify" {
  interface FastifyInstance {
    /** Encrypts/decrypts repository PATs at rest. */
    encryptor: Encryptor;
    /** Checks a repository is reachable (`git ls-remote`). */
    verifyConnection: VerifyConnection;
    /** Directory rendered snapshot exports (SVG/PNG) are cached in (GP-37). */
    exportCacheDir: string;
    /** GitHub REST client for PR comments (GP-38); injectable in tests. */
    github: GitHubClient;
    /** GitLab REST client for MR-note PR comments (GP-53); injectable in tests. */
    gitlab: GitLabClient;
    /** Public origin for absolute PR-comment URLs (GP-38); "" = link-only. */
    publicBaseUrl: string;
  }
}

export type BuildAppOptions = {
  /** Inject a Postgres pool (e.g. a stub in tests). Defaults to a real pool. */
  pool?: Pool;
  /** Inject a JWKS resolver (tests). Otherwise built from OIDC discovery. */
  jwks?: JWTVerifyGetKey;
  /** Inject a connection verifier (tests). Defaults to real `git ls-remote`. */
  verifyConnection?: VerifyConnection;
  /** Inject a GitHub client (tests). Defaults to the real REST client. */
  github?: GitHubClient;
  /** Inject a GitLab client (tests). Defaults to the real REST client. */
  gitlab?: GitLabClient;
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
  await app.register(backgroundPlugin);
  await app.register(dbPlugin, { databaseUrl: env.databaseUrl, pool: opts.pool });

  // Credential encryption (throws in prod if ENCRYPTION_KEY is unset) and the
  // repository connection verifier (overridable in tests to avoid the network).
  app.decorate("encryptor", createEncryptor(env.encryptionKey));
  app.decorate("verifyConnection", opts.verifyConnection ?? realVerifyConnection);
  app.decorate("exportCacheDir", env.exportCacheDir);
  app.decorate("github", opts.github ?? realGitHubClient);
  app.decorate("gitlab", opts.gitlab ?? realGitLabClient);
  app.decorate("publicBaseUrl", env.publicBaseUrl);
  // Global bearer-token auth (skips /healthz and /webhooks/*). Registered
  // before routes so its onRequest hook guards every protected endpoint.
  await app.register(authPlugin, {
    issuer: env.oidcIssuer,
    audience: env.oidcAudience,
    nodeEnv: env.nodeEnv,
    keyResolver: opts.jwks,
  });

  // Readiness probe (with DB check) at the conventional root path.
  await app.register(healthzRoutes);
  // Versioned API routes.
  await app.register(healthRoutes, { prefix: "/api/v1" });
  await app.register(meRoutes, { prefix: "/api/v1" });
  await app.register(projectRoutes, { prefix: "/api/v1" });
  await app.register(repositoryRoutes, { prefix: "/api/v1" });
  await app.register(repositoryFileRoutes, { prefix: "/api/v1" });
  await app.register(ingestionRoutes, { prefix: "/api/v1" });
  await app.register(snapshotRoutes, { prefix: "/api/v1" });
  await app.register(exportRoutes, { prefix: "/api/v1" });
  await app.register(shareRoutes, { prefix: "/api/v1" });
  await app.register(pullRoutes, { prefix: "/api/v1" });
  await app.register(docsRoutes, { prefix: "/api/v1" });

  return app;
}
