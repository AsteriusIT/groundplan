/**
 * The GitHub App credential (GP-193) — the first real use of the GP-192 seam.
 *
 * A GitHub App authenticates in two hops: the app proves itself with a short
 * JWT signed by its private key, then exchanges that for an **installation
 * token** scoped to one organization's selected repositories. Installation
 * tokens last an hour, so nothing long-lived is ever stored: the row holds an
 * installation id and no secret at all.
 *
 * What this buys, beyond hygiene: comments arrive from the app's own bot
 * identity instead of a human's PAT, permissions are the four the manifest asks
 * for (`contents:read`, `pull_requests:write`, `checks:write`, `metadata:read`),
 * and revoking access is one click on GitHub's side — which we then report
 * honestly instead of retrying forever.
 *
 * The App is optional. Without `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` the
 * provider simply offers no `installation_app` flow, which the catalog reports
 * as "not configured on this instance" — the `AI_API_KEY` posture.
 */
import { createSign } from "node:crypto";

import type { GitHubAppConfig } from "../config.js";
import { registerStrategy } from "../credentials.js";
import {
  CredentialRevokedError,
  DiscoveryError,
  toDiscoveryError,
  type AccessToken,
  type ConnectFlow,
  type CredentialStrategy,
  type DiscoveredRepo,
  type NewConnection,
  type RepoDiscoverer,
} from "../types.js";

const API = "https://api.github.com";

/** GitHub rejects an app JWT with more than 10 minutes of life. */
const APP_JWT_TTL_SECONDS = 540;
/** Clock-skew allowance on `iat`, as GitHub's own docs recommend. */
const APP_JWT_BACKDATE_SECONDS = 60;
/** Renew an installation token this long before it expires. */
const RENEW_MARGIN_MS = 60_000;
/** GitHub's maximum page size — fewer round trips for a large installation. */
const PER_PAGE = 100;

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/**
 * Sign the app-level JWT (RS256) that authenticates *the app itself*. Written
 * against `node:crypto` rather than a JWT library: it is three base64url
 * segments and one signature, and the backend already avoids dependencies it
 * can spell out.
 */
export function signAppJwt(
  config: Pick<GitHubAppConfig, "appId" | "privateKey">,
  nowMs: number = Date.now(),
): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iat: now - APP_JWT_BACKDATE_SECONDS,
      exp: now + APP_JWT_TTL_SECONDS,
      iss: config.appId,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(config.privateKey, "base64url")}`;
}

export type GitHubInstallation = {
  id: number;
  /** Login of the org (or user) the app is installed on. */
  account: string | null;
};

export type InstallationToken = { token: string; expiresAt: Date };

/** One repository as `GET /installation/repositories` reports it. */
export type InstallationRepo = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string } | null;
  clone_url: string;
  default_branch: string | null;
  private: boolean;
  archived: boolean;
  updated_at: string | null;
};

/**
 * The app-level calls we make. Injectable (like every REST client here) so the
 * epic is testable without a registered app or a network.
 *
 * `listInstallationRepositories` is the odd one out: it authenticates with the
 * *installation* token rather than the app JWT, because the scope it reports is
 * the installation's, not the app's. It lives here anyway — an installation's
 * repository list is a GitHub App concept and belongs beside the rest of them.
 */
export interface GitHubAppClient {
  getInstallation(
    installationId: number,
    appJwt: string,
  ): Promise<GitHubInstallation>;
  createInstallationToken(
    installationId: number,
    appJwt: string,
  ): Promise<InstallationToken>;
  listInstallationRepositories(
    token: string,
    page: number,
  ): Promise<{ repositories: InstallationRepo[]; totalCount: number }>;
}

/** Thrown for a non-2xx app-level response; the message is safe to store. */
export class GitHubAppError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubAppError";
    this.status = status;
  }
}

function appHeaders(appJwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${appJwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "groundplan",
  };
}

async function appError(res: Response): Promise<GitHubAppError> {
  let detail = res.statusText;
  try {
    const data = (await res.json()) as { message?: string };
    if (data?.message) detail = data.message;
  } catch {
    // non-JSON body — the status text says enough
  }
  return new GitHubAppError(res.status, `GitHub App API ${res.status}: ${detail}`);
}

export const realGitHubAppClient: GitHubAppClient = {
  async getInstallation(installationId, appJwt) {
    const res = await fetch(`${API}/app/installations/${installationId}`, {
      headers: appHeaders(appJwt),
    });
    if (!res.ok) throw await appError(res);
    const body = (await res.json()) as {
      id?: number;
      account?: { login?: string } | null;
    };
    return {
      id: body.id ?? installationId,
      account: body.account?.login ?? null,
    };
  },

  async createInstallationToken(installationId, appJwt) {
    const res = await fetch(
      `${API}/app/installations/${installationId}/access_tokens`,
      { method: "POST", headers: appHeaders(appJwt) },
    );
    if (!res.ok) throw await appError(res);
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token) {
      throw new GitHubAppError(502, "GitHub returned no installation token");
    }
    return {
      token: body.token,
      expiresAt: body.expires_at ? new Date(body.expires_at) : new Date(Date.now() + 3_600_000),
    };
  },

  async listInstallationRepositories(token, page) {
    const res = await fetch(
      `${API}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "groundplan",
        },
      },
    );
    if (!res.ok) throw await appError(res);
    const body = (await res.json()) as {
      total_count?: number;
      repositories?: InstallationRepo[];
    };
    return {
      repositories: body.repositories ?? [],
      totalCount: body.total_count ?? body.repositories?.length ?? 0,
    };
  },
};

/**
 * Installation tokens, cached until shortly before they expire. Keyed by
 * app + installation so two apps in one process (tests) never share a token,
 * and held in memory only — a token that outlives the process would be a
 * long-lived secret, which is the thing this whole story removes.
 */
const tokenCache = new Map<string, InstallationToken>();

/** Test seam: drop every cached installation token. */
export function clearInstallationTokenCache(): void {
  tokenCache.clear();
}

/**
 * A token for one installation, minted or reused. A 401/403/404 from GitHub is
 * a revoked or removed installation — `CredentialRevokedError`, the one failure
 * that asks a human to reconnect. Anything else propagates as itself so a
 * transient 500 is not mistaken for a revocation.
 */
export async function installationToken(
  config: GitHubAppConfig,
  client: GitHubAppClient,
  installationId: number,
  nowMs: number = Date.now(),
): Promise<AccessToken> {
  const key = `${config.appId}:${installationId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt.getTime() - RENEW_MARGIN_MS > nowMs) {
    return { token: cached.token, expiresAt: cached.expiresAt };
  }

  try {
    const minted = await client.createInstallationToken(
      installationId,
      signAppJwt(config, nowMs),
    );
    tokenCache.set(key, minted);
    return { token: minted.token, expiresAt: minted.expiresAt };
  } catch (err) {
    tokenCache.delete(key);
    if (err instanceof GitHubAppError && [401, 403, 404].includes(err.status)) {
      throw new CredentialRevokedError(
        "the GitHub App installation is no longer available (it may have been uninstalled or its access revoked)",
      );
    }
    throw err;
  }
}

/** The `installation_app` strategy for one stored connection. */
export function installationStrategy(
  config: GitHubAppConfig,
  client: GitHubAppClient,
  installationId: number,
): CredentialStrategy {
  return {
    mode: "installation_app",
    getToken: () => installationToken(config, client, installationId),
  };
}

/**
 * Discovery for a GitHub App installation (GP-227): the exact set of
 * repositories the installation was granted, whether that is an entire
 * organization or the three someone ticked in "Only select repositories".
 *
 * The cursor is our own page number, stringified — deliberately not GitHub's
 * `Link` header URL. A caller that could round-trip a provider URL back to us
 * would be choosing what we fetch, and one day that URL would point somewhere
 * else entirely.
 */
export function githubAppDiscoverer(client: GitHubAppClient): RepoDiscoverer {
  return {
    async listRepositories(connection, cursor) {
      if (!connection.config.installationId) {
        throw new DiscoveryError(
          "installation_not_linked",
          "this connection is not a GitHub App installation, so it has no repository list",
        );
      }
      const page = parseCursor(cursor);

      let token: string;
      try {
        ({ token } = await connection.credential.getToken());
      } catch (err) {
        // A revoked installation is the one failure a human must act on; it is
        // already typed by the strategy, so only the vocabulary changes here.
        if (err instanceof CredentialRevokedError) {
          throw new DiscoveryError("installation_revoked", err.message);
        }
        throw err;
      }

      let result;
      try {
        result = await client.listInstallationRepositories(token, page);
      } catch (err) {
        throw asDiscoveryError(err);
      }

      const repos = result.repositories.map(toDiscoveredRepo);
      // GitHub reports the total, so "is there another page?" is arithmetic
      // rather than a guess from a short page — a full last page would otherwise
      // cost one extra empty request every time.
      const seen = (page - 1) * PER_PAGE + repos.length;
      const more = repos.length > 0 && seen < result.totalCount;
      return { repos, nextCursor: more ? String(page + 1) : null };
    },
  };
}

/** A cursor we did not issue restarts at page 1 rather than throwing. */
function parseCursor(cursor: string | null | undefined): number {
  const page = Number.parseInt(cursor ?? "1", 10);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function toDiscoveredRepo(repo: InstallationRepo): DiscoveredRepo {
  const [ownerFromFullName] = repo.full_name.split("/");
  return {
    externalId: String(repo.id),
    fullName: repo.full_name,
    owner: repo.owner?.login ?? ownerFromFullName ?? "",
    name: repo.name,
    cloneUrl: repo.clone_url,
    // GitHub always reports one; the fallback keeps a malformed payload from
    // producing a repository we would then try to clone at `refs/heads/null`.
    defaultBranch: repo.default_branch ?? "main",
    private: repo.private,
    archived: repo.archived,
    updatedAt: repo.updated_at ? new Date(repo.updated_at) : null,
  };
}

/**
 * Map a GitHub failure onto the vocabulary the onboarding UI speaks. Every
 * status GitHub answers with means something different to the person waiting:
 * 404 and 401 are "this installation is gone", 403 is "it is there but may not
 * do this". Anything else stays `unavailable` — an outage is not a revocation.
 */
function asDiscoveryError(err: unknown): DiscoveryError {
  if (err instanceof GitHubAppError) {
    if (err.status === 401 || err.status === 404) {
      return new DiscoveryError(
        "installation_revoked",
        "the GitHub App installation is no longer available (it may have been uninstalled or its access revoked)",
      );
    }
    if (err.status === 403) {
      return new DiscoveryError(
        "insufficient_permissions",
        "the GitHub App installation is not allowed to list its repositories — review the app's permissions",
      );
    }
  }
  return toDiscoveryError(err);
}

/**
 * The install flow. There is no authorization code to exchange: GitHub sends the
 * browser back to `setup_url` with an `installation_id`, and the app JWT proves
 * the installation is real and reachable before anything is stored.
 */
export function githubAppConnectFlow(
  config: GitHubAppConfig,
  client: GitHubAppClient,
): ConnectFlow {
  return {
    mode: "installation_app",
    start() {
      return {
        carry: {},
        authorizeUrl: (state) =>
          `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`,
      };
    },
    async complete({ params }): Promise<NewConnection> {
      const raw = params["installation_id"];
      const installationId = Number.parseInt(raw ?? "", 10);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) {
        throw new GitHubAppError(
          422,
          "GitHub did not return an installation id — start the installation again",
        );
      }
      // Prove it before storing it: an id we cannot read is not a connection.
      const installation = await client.getInstallation(
        installationId,
        signAppJwt(config),
      );
      return {
        name: installation.account ?? `installation ${installationId}`,
        config: { installationId, account: installation.account },
        // Nothing to keep: the private key is the app's, not the installation's.
        secret: null,
      };
    },
  };
}

/**
 * Register the strategy factory once, at module load. The factory reads the
 * app's own configuration, so two Fastify instances in one test process each get
 * a correctly-configured strategy from this single registration.
 */
registerStrategy("github", "installation_app", (app, row) => {
  const config = app.integrations.githubApp;
  const installationId = row.config.installationId;
  if (!config || !installationId) {
    return {
      mode: "installation_app",
      getToken: () =>
        Promise.reject(
          new CredentialRevokedError(
            "the GitHub App is not configured on this instance — reconnect this repository with a token",
          ),
        ),
    };
  }
  return installationStrategy(config, app.githubApp, installationId);
});
