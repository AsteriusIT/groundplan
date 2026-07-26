/**
 * Credential strategies (GP-192): turning what is stored into a token.
 *
 * Every path that authenticates to a provider — clone, `ls-remote`, PR comment,
 * webhook registration — goes through `resolveRepositoryCredential`. It answers
 * with a `CredentialStrategy` and never with a column, which is what makes a
 * GitHub App installation, an OAuth connection and a pasted PAT interchangeable
 * everywhere downstream.
 *
 * Resolution order is deliberate and short:
 *   1. the org connection the repository points at (`credential_id`), if any;
 *   2. otherwise the repository's own PAT.
 * A repository with neither has no strategy — the callers already handle "no
 * credential" (a public repo, or an honest error), so this returns null.
 *
 * The `oauth2` and `installation_app` factories are *registered* by the epics
 * that own those flows (GP-193/195/196) rather than imported here: this module
 * is the seam, not the place every provider's OAuth ends up.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import {
  integrationCredentials,
  repositories,
  type IntegrationCredentialRow,
  type RepositoryRow,
} from "../db/schema.js";
import type { OAuth2Store } from "./oauth2.js";
import {
  CredentialRevokedError,
  type AccessToken,
  type CredentialMode,
  type CredentialStrategy,
} from "./types.js";

/**
 * Builds the strategy for one stored credential row. It receives the app so it
 * can read that instance's configuration (the GitHub App keys, the OAuth client)
 * — two apps in one test process therefore get two correctly-configured
 * strategies from the same registration.
 */
export type StrategyFactory = (
  app: FastifyInstance,
  row: IntegrationCredentialRow,
) => CredentialStrategy;

const factories = new Map<string, StrategyFactory>();

/** Key on provider+mode: GitLab and Entra are both `oauth2`, not the same flow. */
const factoryKey = (provider: string, mode: CredentialMode): string =>
  `${provider}:${mode}`;

/**
 * Register the strategy factory for one provider+mode. Called at module load by
 * the epic that owns the flow (GP-193 GitHub App, GP-195 GitLab, GP-196 Entra),
 * so registration cannot drift out of step with the adapter.
 */
export function registerStrategy(
  provider: string,
  mode: CredentialMode,
  factory: StrategyFactory,
): void {
  factories.set(factoryKey(provider, mode), factory);
}

/** Is a strategy registered for this provider+mode? (Contract tests ask.) */
export function hasStrategy(provider: string, mode: CredentialMode): boolean {
  return factories.has(factoryKey(provider, mode));
}

/** A strategy over an already-known plaintext token. */
export function staticStrategy(
  mode: CredentialMode,
  token: string,
  expiresAt: Date | null = null,
): CredentialStrategy {
  return {
    mode,
    getToken: async (): Promise<AccessToken> => ({ token, expiresAt }),
  };
}

/**
 * The strategy for a stored connection row. A mode with no registered factory
 * (an install that never configured the GitHub App, say) fails honestly at use
 * time rather than crashing at boot.
 */
export function strategyForCredential(
  app: FastifyInstance,
  row: IntegrationCredentialRow,
): CredentialStrategy {
  const factory = factories.get(factoryKey(row.provider, row.mode));
  if (factory) return factory(app, row);
  return {
    mode: row.mode,
    getToken: () =>
      Promise.reject(
        new CredentialRevokedError(
          `no ${row.mode} handler is configured for ${row.provider} on this instance`,
        ),
      ),
  };
}

/** Load one connection row by id, or undefined. */
export async function loadCredential(
  app: FastifyInstance,
  id: string,
): Promise<IntegrationCredentialRow | undefined> {
  const [row] = await app.db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, id));
  return row;
}

/**
 * The strategy that authenticates a repository, or null when it has none.
 * A PAT that will not decrypt is treated as "no credential": a corrupt
 * ciphertext is not something a retry fixes, and the callers report it as such.
 */
export async function resolveRepositoryCredential(
  app: FastifyInstance,
  repo: RepositoryRow,
): Promise<CredentialStrategy | null> {
  if (repo.credentialId) {
    const row = await loadCredential(app, repo.credentialId);
    // The FK is `set null` on delete, so a miss is only a race. Fall through to
    // the PAT rather than failing — the repository may still have one.
    if (row) return strategyForCredential(app, row);
  }
  if (!repo.accessToken) return null;
  try {
    return staticStrategy("pat", app.encryptor.decrypt(repo.accessToken));
  } catch (err) {
    app.log.warn({ err, repositoryId: repo.id }, "could not decrypt stored PAT");
    return null;
  }
}

/**
 * The plaintext token authenticating a repository, or null — the wrapper for
 * callers that only want a string (clone, ls-remote, PR comment). A revoked
 * connection throws `CredentialRevokedError`, which callers surface to the user
 * instead of retrying forever.
 */
export async function repositoryAccessToken(
  app: FastifyInstance,
  repo: RepositoryRow,
): Promise<{ token: string; mode: CredentialMode } | null> {
  const strategy = await resolveRepositoryCredential(app, repo);
  if (!strategy) return null;
  const { token } = await strategy.getToken();
  return { token, mode: strategy.mode };
}

/** Every repository currently authenticating through one connection (GP-198). */
export async function repositoriesUsingCredential(
  app: FastifyInstance,
  credentialId: string,
): Promise<{ id: string; url: string }[]> {
  return app.db
    .select({ id: repositories.id, url: repositories.url })
    .from(repositories)
    .where(eq(repositories.credentialId, credentialId));
}

/**
 * The `OAuth2Store` view of a connection row (GP-197) — how the shared refresh
 * logic reads and writes this table without knowing it exists.
 */
export function credentialStore(
  app: FastifyInstance,
  row: IntegrationCredentialRow,
): OAuth2Store {
  return {
    id: row.id,
    secretCiphertext: row.secret,
    healthy: row.status === "ok",
    async persistSecret(ciphertext) {
      await app.db
        .update(integrationCredentials)
        .set({ secret: ciphertext, updatedAt: new Date() })
        .where(eq(integrationCredentials.id, row.id));
    },
    async markStatus(healthy, error) {
      await setCredentialStatus(
        app,
        row.id,
        healthy ? "ok" : "reconnect_required",
        error,
      );
    },
  };
}

/** Record a connection's health after a token attempt (GP-192). */
export async function setCredentialStatus(
  app: FastifyInstance,
  credentialId: string,
  status: "ok" | "reconnect_required" | "unverified",
  lastError: string | null,
): Promise<void> {
  await app.db
    .update(integrationCredentials)
    .set({ status, lastError, updatedAt: new Date() })
    .where(eq(integrationCredentials.id, credentialId));
}
