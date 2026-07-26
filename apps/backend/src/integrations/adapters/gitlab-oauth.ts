/**
 * GitLab OAuth 2.0 (GP-195): the second credential mode, and the first user of
 * the shared OAuth engine.
 *
 * One configured instance per deployment (`GITLAB_URL`, default `gitlab.com`),
 * because an OAuth application belongs to an instance — a self-managed GitLab
 * needs its own registration, which is exactly the same three env vars pointed
 * somewhere else. Group access tokens remain the documented alternative for
 * self-managed installs that would rather not register an app at all, and a PAT
 * remains available everywhere.
 *
 * Scopes: `api` (posting merge-request notes needs it, `read_repository` is not
 * enough) plus `read_repository` for the clone, and `offline_access`… which
 * GitLab does not use — it issues refresh tokens for any authorization-code
 * grant. The engine refuses a response without one, so a misconfigured
 * application fails at connect time rather than silently an hour later.
 */
import type { GitLabOAuthConfig } from "../config.js";
import { registerStrategy } from "../credentials.js";
import {
  oauth2ConnectFlow,
  oauth2Strategy,
  type OAuth2Config,
  type OAuth2Http,
} from "../oauth2.js";
import type { ConnectFlow, CredentialStrategy } from "../types.js";

/** Endpoints are derived from the instance URL — the same shape everywhere. */
export function gitlabOAuthConfig(config: GitLabOAuthConfig): OAuth2Config {
  const base = config.instanceUrl.replace(/\/+$/, "");
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authorizeUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,
    scope: "api read_repository",
  };
}

type GitLabUser = { username?: string; name?: string };

/**
 * Name the connection after the account that authorized it, and record which
 * instance it belongs to — a deployment can be re-pointed, and a connection
 * that does not say where it leads is a mystery six months later.
 */
export function gitlabConnectFlow(
  config: GitLabOAuthConfig,
  http: OAuth2Http,
): ConnectFlow {
  const oauth = gitlabOAuthConfig(config);
  const base = config.instanceUrl.replace(/\/+$/, "");
  return oauth2ConnectFlow(oauth, http, async ({ tokens }) => {
    const user = (await http.getJson(
      `${base}/api/v4/user`,
      tokens.access_token,
    )) as GitLabUser;
    const account = user.username ?? user.name ?? null;
    return {
      name: account ? `GitLab · ${account}` : `GitLab · ${new URL(base).host}`,
      config: { account, instanceUrl: base },
    };
  });
}

export function gitlabOAuthStrategy(
  app: Parameters<typeof oauth2Strategy>[0],
  row: Parameters<typeof oauth2Strategy>[1],
  config: GitLabOAuthConfig,
  http: OAuth2Http,
): CredentialStrategy {
  return oauth2Strategy(app, row, gitlabOAuthConfig(config), http);
}

/**
 * Registered at module load, like the GitHub App's. A connection made on an
 * instance this deployment no longer points at still refreshes correctly: the
 * row remembers its own `instanceUrl`, and only the client credentials come
 * from the environment.
 */
registerStrategy("gitlab", "oauth2", (app, row) => {
  const configured = app.integrations.gitlabOAuth;
  if (!configured) {
    return {
      mode: "oauth2",
      getToken: () =>
        Promise.reject(
          new Error(
            "GitLab OAuth is not configured on this instance — reconnect this repository with a token",
          ),
        ),
    };
  }
  // The row's own instance wins over the currently-configured one.
  const config: GitLabOAuthConfig = {
    ...configured,
    instanceUrl: row.config.instanceUrl ?? configured.instanceUrl,
  };
  return gitlabOAuthStrategy(app, row, config, app.oauth2Http);
});
