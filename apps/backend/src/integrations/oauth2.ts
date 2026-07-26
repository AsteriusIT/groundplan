/**
 * The OAuth 2.0 authorization-code engine (GP-195), shared by every provider
 * that speaks it: GitLab, Microsoft Entra ID for Azure DevOps (GP-196),
 * Atlassian 3LO for Confluence (GP-197).
 *
 * They differ in three endpoint URLs, a scope string and how the account is
 * named — nothing else — so writing this once and configuring it three times is
 * both less code and less surface for one of them to drift.
 *
 * Two rules the whole thing hangs on:
 *
 *  - **PKCE always**, even though we are a confidential client with a secret. It
 *    costs a hash and removes the class of attacks where a leaked authorization
 *    code is enough. The verifier travels in the sealed state, so the browser
 *    holds nothing usable.
 *  - **Rotation is expected.** GitLab (and Atlassian) hand back a *new* refresh
 *    token on every refresh and invalidate the old one; a client that ignores
 *    that works until it doesn't. Every refresh persists what came back.
 *
 * `invalid_grant` is the one error that means a human must act: the grant is
 * gone (revoked, expired, rotated past). It becomes `CredentialRevokedError`,
 * which flips the connection to `reconnect_required`. Everything else is
 * transient and is retried on the next call, not turned into a scary state.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";

import {
  CredentialRevokedError,
  type AccessToken,
  type ConnectFlow,
  type CredentialStrategy,
  type NewConnection,
} from "./types.js";

/** Renew an access token this long before it expires. */
const RENEW_MARGIN_MS = 60_000;

export type OAuth2TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

/** Thrown for a non-2xx token response; `revoked` is the `invalid_grant` case. */
export class OAuth2Error extends Error {
  readonly revoked: boolean;
  constructor(message: string, revoked: boolean) {
    super(message);
    this.name = "OAuth2Error";
    this.revoked = revoked;
  }
}

/**
 * The two HTTP calls an OAuth flow makes. Injectable (like every client here)
 * so the epics are tested end to end without an identity provider.
 */
export interface OAuth2Http {
  /** POST the token endpoint with a form body. */
  token(
    tokenUrl: string,
    form: Record<string, string>,
  ): Promise<OAuth2TokenResponse>;
  /** GET a JSON resource with a bearer token (naming the connected account). */
  getJson(url: string, accessToken: string): Promise<unknown>;
}

async function tokenError(res: Response): Promise<OAuth2Error> {
  let code = "";
  let description = res.statusText;
  try {
    const body = (await res.json()) as {
      error?: string;
      error_description?: string;
    };
    code = body.error ?? "";
    description = body.error_description ?? body.error ?? description;
  } catch {
    // non-JSON body — the status text is what we have
  }
  // `invalid_grant` is the provider saying "this grant no longer exists".
  return new OAuth2Error(
    `the identity provider refused the token request: ${description}`,
    code === "invalid_grant",
  );
}

export const realOAuth2Http: OAuth2Http = {
  async token(tokenUrl, form) {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": "groundplan",
      },
      body: new URLSearchParams(form).toString(),
    });
    if (!res.ok) throw await tokenError(res);
    return (await res.json()) as OAuth2TokenResponse;
  },

  async getJson(url, accessToken) {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": "groundplan",
      },
    });
    if (!res.ok) {
      throw new OAuth2Error(
        `the provider answered ${res.status} for ${new URL(url).pathname}`,
        res.status === 401,
      );
    }
    return res.json();
  },
};

/** A PKCE verifier and its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export type OAuth2Config = {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** Provider-specific authorize parameters (Atlassian's `audience`, `prompt`). */
  extraAuthorizeParams?: Record<string, string>;
  /**
   * Extra form fields on the **refresh** request. Entra ID wants the scope
   * repeated; most providers want nothing. Kept explicit rather than always
   * sending the scope, because GitLab rejects a refresh that narrows it.
   */
  refreshParams?: Record<string, string>;
};

/**
 * Turn a fresh token response into the connection to store. Each provider
 * supplies its own: which API names the account, what identifies the target
 * (an instance URL, an Atlassian cloud id).
 */
export type DescribeConnection = (args: {
  tokens: OAuth2TokenResponse;
  params: Record<string, string>;
  http: OAuth2Http;
}) => Promise<Omit<NewConnection, "secret">>;

/**
 * The browser half: authorize with PKCE, then exchange the code. The refresh
 * token is what gets stored — the access token is deliberately not, because it
 * is stale within the hour and the strategy mints one on demand anyway.
 */
export function oauth2ConnectFlow(
  config: OAuth2Config,
  http: OAuth2Http,
  describe: DescribeConnection,
): ConnectFlow {
  return {
    mode: "oauth2",
    start({ redirectUri }) {
      const { verifier, challenge } = createPkcePair();
      return {
        carry: { verifier },
        authorizeUrl(state) {
          const url = new URL(config.authorizeUrl);
          url.searchParams.set("client_id", config.clientId);
          url.searchParams.set("redirect_uri", redirectUri);
          url.searchParams.set("response_type", "code");
          url.searchParams.set("scope", config.scope);
          url.searchParams.set("state", state);
          url.searchParams.set("code_challenge", challenge);
          url.searchParams.set("code_challenge_method", "S256");
          for (const [key, value] of Object.entries(
            config.extraAuthorizeParams ?? {},
          )) {
            url.searchParams.set(key, value);
          }
          return url.toString();
        },
      };
    },

    async complete({ params, carry, redirectUri }) {
      const code = params["code"];
      if (!code) {
        throw new OAuth2Error(
          "the provider returned no authorization code — start the connection again",
          false,
        );
      }
      const verifier = carry["verifier"];
      if (!verifier) {
        throw new OAuth2Error(
          "this connection attempt is missing its verifier — start it again",
          false,
        );
      }

      const tokens = await http.token(config.tokenUrl, {
        grant_type: "authorization_code",
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });

      const described = await describe({ tokens, params, http });
      if (!tokens.refresh_token) {
        // Without one we could never renew, and would silently stop working in
        // an hour. Refusing now is the honest failure.
        throw new OAuth2Error(
          "the provider issued no refresh token — check the app is configured for offline access",
          false,
        );
      }
      return {
        ...described,
        config: { ...described.config, scope: tokens.scope ?? config.scope },
        secret: tokens.refresh_token,
      };
    },
  };
}

/**
 * Where a connection's refresh token lives, abstracted (GP-197). Git provider
 * connections sit in `integration_credentials`; the Atlassian one sits in
 * `integrations`, beside the Confluence credential it replaces. The refresh
 * logic does not care which — it needs to read a secret, write a rotated one
 * back, and record health.
 */
export type OAuth2Store = {
  /** Stable id — the access-token cache key. */
  id: string;
  /** The stored refresh token, still encrypted. */
  secretCiphertext: string | null;
  /** Whether the record currently reads as healthy (to avoid a needless write). */
  healthy: boolean;
  persistSecret(ciphertext: string): Promise<void>;
  markStatus(healthy: boolean, error: string | null): Promise<void>;
};

/**
 * Access tokens, in memory only, keyed by connection. Never persisted: an
 * access token outliving the process would be a long-lived secret at rest, and
 * the refresh token already is the durable one.
 */
const accessTokens = new Map<string, AccessToken>();

/** Test seam: forget every cached access token. */
export function clearAccessTokenCache(): void {
  accessTokens.clear();
}

/**
 * The `oauth2` strategy for one stored connection: hand out the cached access
 * token, or refresh. A rotated refresh token is written back in the same step
 * that used it, so the stored one is never the one already spent.
 */
export function oauth2Strategy(
  app: FastifyInstance,
  store: OAuth2Store,
  config: OAuth2Config,
  http: OAuth2Http,
): CredentialStrategy {
  return {
    mode: "oauth2",
    async getToken(): Promise<AccessToken> {
      const cached = accessTokens.get(store.id);
      if (cached?.expiresAt && cached.expiresAt.getTime() - RENEW_MARGIN_MS > Date.now()) {
        return cached;
      }

      if (!store.secretCiphertext) {
        throw new CredentialRevokedError(
          "this connection has no refresh token stored — reconnect it",
        );
      }
      let refreshToken: string;
      try {
        refreshToken = app.encryptor.decrypt(store.secretCiphertext);
      } catch {
        throw new CredentialRevokedError(
          "this connection's stored credential could not be read — reconnect it",
        );
      }

      let tokens: OAuth2TokenResponse;
      try {
        tokens = await http.token(config.tokenUrl, {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          ...config.refreshParams,
        });
      } catch (err) {
        accessTokens.delete(store.id);
        if (err instanceof OAuth2Error && err.revoked) {
          const message =
            "the provider rejected the stored authorization — reconnect this integration";
          await store.markStatus(false, message);
          throw new CredentialRevokedError(message);
        }
        throw err;
      }

      // Rotation: the token we just used may already be dead. Persist the new
      // one before handing out the access token that came with it.
      if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
        await store.persistSecret(app.encryptor.encrypt(tokens.refresh_token));
      }
      if (!store.healthy) await store.markStatus(true, null);

      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null;
      const token: AccessToken = { token: tokens.access_token, expiresAt };
      if (expiresAt) accessTokens.set(store.id, token);
      return token;
    },
  };
}
