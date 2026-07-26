/**
 * Confluence through Atlassian OAuth 2.0 (3LO) — GP-197.
 *
 * GP-183 moved the Confluence credential to an org-level Integration; this
 * replaces *what* that credential is. Instead of an API token somebody pasted
 * (and must rotate by hand), the org authorizes an Atlassian app once and we
 * hold a refresh token, exchanging it for a short-lived Bearer token per call.
 *
 * Two things follow from Atlassian's design and are worth knowing before
 * touching this:
 *
 *  - **The base URL changes.** A 3LO token does not authenticate against
 *    `your-site.atlassian.net/wiki`; it goes through the gateway at
 *    `api.atlassian.com/ex/confluence/{cloudId}`. The rest of the REST v1 path
 *    is identical, so `confluenceApiUrl` and every call built on it are
 *    unchanged — only the stored `baseUrl` differs. The site's human URL is
 *    kept separately, for links a person clicks.
 *  - **Data Center has no 3LO.** The `cloud_token` and `dc_pat` modes stay
 *    exactly as they were; this is a third option, not a migration. An org with
 *    per-repo credentials from GP-179 keeps publishing while it moves.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import {
  integrations,
  type AtlassianIntegrationConfig,
  type IntegrationRow,
} from "../db/schema.js";
import type { AtlassianOAuthConfig } from "./config.js";
import {
  oauth2ConnectFlow,
  oauth2Strategy,
  OAuth2Error,
  type OAuth2Config,
  type OAuth2Http,
  type OAuth2Store,
} from "./oauth2.js";
import type { ConnectFlow, CredentialStrategy } from "./types.js";

/** Where Atlassian says which sites the grant covers. */
const ACCESSIBLE_RESOURCES_URL =
  "https://api.atlassian.com/oauth/token/accessible-resources";

/**
 * The narrowest scopes that let us publish a page with a diagram attached and
 * check the space exists first. `offline_access` is what makes Atlassian issue
 * a refresh token at all.
 */
const SCOPES = [
  "offline_access",
  "read:confluence-space.summary",
  "read:confluence-content.all",
  "write:confluence-content",
  "write:confluence-file",
].join(" ");

export function atlassianOAuthConfig(config: AtlassianOAuthConfig): OAuth2Config {
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scope: SCOPES,
    // `audience` is how Atlassian knows which API the grant is for; `prompt` is
    // what makes it hand back a refresh token on a re-authorization.
    extraAuthorizeParams: { audience: "api.atlassian.com", prompt: "consent" },
  };
}

type AccessibleResource = { id?: string; url?: string; name?: string };

/** The REST base a 3LO token authenticates against, for one site. */
export function cloudApiBase(cloudId: string): string {
  return `https://api.atlassian.com/ex/confluence/${cloudId}`;
}

/**
 * The connect flow. After the exchange it asks Atlassian which sites the grant
 * covers and takes the first — a 3LO consent names one site in practice, and
 * making the user pick from a list of one is a worse experience than letting
 * them reconnect if they authorized the wrong one.
 */
export function atlassianConnectFlow(
  config: AtlassianOAuthConfig,
  http: OAuth2Http,
): ConnectFlow {
  return oauth2ConnectFlow(atlassianOAuthConfig(config), http, async ({ tokens }) => {
    const resources = (await http.getJson(
      ACCESSIBLE_RESOURCES_URL,
      tokens.access_token,
    )) as AccessibleResource[];
    const site = Array.isArray(resources) ? resources[0] : undefined;
    if (!site?.id) {
      throw new OAuth2Error(
        "this Atlassian account granted access to no Confluence site",
        false,
      );
    }
    return {
      name: site.name ?? site.url ?? "Confluence",
      config: { cloudId: site.id, instanceUrl: site.url ?? null },
    };
  });
}

/** The `OAuth2Store` view of an Integration row — see `credentialStore`. */
export function integrationStore(
  app: FastifyInstance,
  row: IntegrationRow,
): OAuth2Store {
  return {
    id: row.id,
    secretCiphertext: row.credential,
    healthy: row.connectionStatus === "ok",
    async persistSecret(ciphertext) {
      await app.db
        .update(integrations)
        .set({ credential: ciphertext })
        .where(eq(integrations.id, row.id));
    },
    async markStatus(healthy, error) {
      await app.db
        .update(integrations)
        .set({
          connectionStatus: healthy ? "ok" : "failed",
          lastError: error,
          ...(healthy ? { verifiedAt: new Date() } : {}),
        })
        .where(eq(integrations.id, row.id));
    },
  };
}

/** The credential strategy behind an OAuth-connected Atlassian integration. */
export function atlassianStrategy(
  app: FastifyInstance,
  row: IntegrationRow,
  config: AtlassianOAuthConfig,
  http: OAuth2Http,
): CredentialStrategy {
  return oauth2Strategy(
    app,
    integrationStore(app, row),
    atlassianOAuthConfig(config),
    http,
  );
}

/**
 * The credential to authenticate one Confluence call with: a fresh access token
 * for an OAuth integration, the stored token/PAT otherwise. Every Confluence
 * caller goes through here, so no call site has to know which mode it is on.
 */
export async function atlassianCredential(
  app: FastifyInstance,
  row: IntegrationRow,
): Promise<string> {
  const config = row.config as AtlassianIntegrationConfig;
  if (config.authType !== "oauth") return app.encryptor.decrypt(row.credential);

  const oauth = app.integrations.atlassianOAuth;
  if (!oauth) {
    throw new OAuth2Error(
      "the Atlassian OAuth app is not configured on this instance — reconnect this integration with a token",
      false,
    );
  }
  const { token } = await atlassianStrategy(app, row, oauth, app.oauth2Http).getToken();
  return token;
}
