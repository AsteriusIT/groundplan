import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import type { JWTVerifyGetKey } from "jose";
import type { Pool } from "pg";

import type { AppEnv } from "./config/env.js";
import { createEncryptor, type Encryptor } from "./lib/encryption.js";
import { realGitHubClient, type GitHubClient } from "./services/github.js";
import { realGitLabClient, type GitLabClient } from "./services/gitlab.js";
import {
  realAzureDevOpsClient,
  type AzureDevOpsClient,
} from "./services/azure-devops.js";
import {
  realAiProvider,
  realStudioModel,
  type AiProvider,
} from "./services/ai.js";
import type { LanguageModel } from "ai";
import {
  realConfluenceClient,
  type ConfluenceClient,
} from "./services/confluence.js";
import { realK8sReader, type K8sReader } from "./services/k8s-reader.js";
import { realK8sVerify, type K8sVerify } from "./services/k8s-verify.js";
import { authPlugin } from "./plugins/auth.js";
import { backgroundPlugin } from "./plugins/background.js";
import { dbPlugin } from "./plugins/db.js";
import { refPollerPlugin } from "./plugins/ref-poller.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import {
  verifyConnection as realVerifyConnection,
  type RepoSource,
  type VerifyResult,
} from "./services/repo-files.js";
import { orgScopePlugin } from "./plugins/org-scope.js";
// Global (not org-scoped) route plugins.
import { aiStatusRoutes } from "./routes/ai.js";
import { aiStudioRoutes } from "./routes/ai-studio.js";
import { healthRoutes } from "./routes/health.js";
import { healthzRoutes } from "./routes/healthz.js";
import { ingestionRoutes } from "./routes/ingestion.js";
import { invitationAcceptRoutes } from "./routes/invitations.js";
import { meRoutes } from "./routes/me.js";
import { orgRoutes } from "./routes/organizations.js";
import { playgroundRoutes } from "./routes/playground.js";
import { settingsRoutes } from "./routes/settings.js";
import { sharePublicRoutes } from "./routes/share-links.js";

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
    /** Azure DevOps REST client for PR-thread comments (GP-54); injectable in tests. */
    azureDevOps: AzureDevOpsClient;
    /** Public origin for absolute PR-comment URLs (GP-38); "" = link-only. */
    publicBaseUrl: string;
    /** The AI layer's model access (GP-62). `model === null` = layer disabled. */
    ai: AiProvider;
    /** The AI studio's chat model (GP-137). `null` = studio disabled (no key). */
    studioModel: LanguageModel | null;
    /** Confluence REST client (GP-179); injectable in tests. */
    confluence: ConfluenceClient;
    /** Checks a Kubernetes cluster is reachable (GP-95); injectable in tests. */
    k8sVerify: K8sVerify;
    /** Lists namespaces and reads one (GP-97); injectable in tests. */
    k8s: K8sReader;
    /** Deployment mode (GP-115): true = single-org (self-hosted), false = SaaS. */
    singleOrg: boolean;
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
  /** Inject an Azure DevOps client (tests). Defaults to the real REST client. */
  azureDevOps?: AzureDevOpsClient;
  /** Inject an AI provider (tests). Defaults to the real one (off without a key). */
  ai?: AiProvider;
  /** Inject the studio chat model (tests). Defaults to real (null without a key). */
  studioModel?: LanguageModel | null;
  /** Inject a Confluence client (tests). Defaults to the real REST client. */
  confluence?: ConfluenceClient;
  /** Inject a cluster verifier (tests). Defaults to the real `/version` check. */
  k8sVerify?: K8sVerify;
  /** Inject a cluster reader (tests). Defaults to the real Kubernetes client. */
  k8s?: K8sReader;
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
  app.decorate("azureDevOps", opts.azureDevOps ?? realAzureDevOpsClient);
  app.decorate("publicBaseUrl", env.publicBaseUrl);
  app.decorate("confluence", opts.confluence ?? realConfluenceClient);
  // AI layer (GP-62). Without AI_API_KEY the real provider reports model: null,
  // so /ai/status says disabled and no generation route can reach a model.
  app.decorate("ai", opts.ai ?? realAiProvider(env));
  app.decorate<LanguageModel | null>(
    "studioModel",
    opts.studioModel ?? realStudioModel(env),
  );
  // Cluster reachability (GP-95). Injected in tests, so the Kubernetes epic is
  // exercised end-to-end without a cluster — and CI never reaches one.
  app.decorate("k8sVerify", opts.k8sVerify ?? realK8sVerify);
  app.decorate("k8s", opts.k8s ?? realK8sReader);
  // Deployment mode (GP-115), read by /me and the org-creation gate.
  app.decorate("singleOrg", env.singleOrg);
  // Global bearer-token auth (skips /healthz and /webhooks/*). Registered
  // before routes so its onRequest hook guards every protected endpoint.
  await app.register(authPlugin, {
    issuer: env.oidcIssuer,
    audience: env.oidcAudience,
    nodeEnv: env.nodeEnv,
    singleOrg: env.singleOrg,
    keyResolver: opts.jwks,
  });

  // Readiness probe (with DB check) at the conventional root path.
  await app.register(healthzRoutes);

  // Global (not org-scoped) API routes: health, the current user, organization
  // management, the CI webhook (its own secret), app-wide settings, the public
  // share views, and the AI status readout. See org-scope for the rest.
  await app.register(healthRoutes, { prefix: "/api/v1" });
  await app.register(meRoutes, { prefix: "/api/v1" });
  await app.register(orgRoutes, { prefix: "/api/v1" });
  await app.register(invitationAcceptRoutes, { prefix: "/api/v1" });
  await app.register(ingestionRoutes, { prefix: "/api/v1" });
  await app.register(settingsRoutes, { prefix: "/api/v1" });
  await app.register(sharePublicRoutes, { prefix: "/api/v1" });
  await app.register(aiStatusRoutes, { prefix: "/api/v1" });
  // Playground (GP-123): user-scoped, org-free — parse is ephemeral, drafts
  // belong to their author alone, so none of it sits under /orgs/:orgId.
  await app.register(playgroundRoutes, { prefix: "/api/v1" });
  // AI studio (GP-137): stateless chat + parse — nothing an org owns, so it
  // sits beside the playground, behind the same global auth hook.
  await app.register(aiStudioRoutes, { prefix: "/api/v1" });

  // Everything a tenant owns — projects, repos, snapshots, PRs, clusters, docs,
  // annotations, AI generation, exports, tours, dashboard — lives under
  // `/api/v1/orgs/:orgId`, behind the org-scope guard (membership + ownership).
  await app.register(orgScopePlugin, { prefix: "/api/v1/orgs/:orgId" });

  // Ref poller (GP-107): the background `git ls-remote` loop that keeps docs and
  // PR state in sync with the git remote. `pollRefsOnce` is always available;
  // the timer only runs outside tests, so route tests build apps without a clock.
  await app.register(refPollerPlugin, {
    intervalMs: env.nodeEnv === "test" ? 0 : env.refPollIntervalMs,
  });

  return app;
}
