/**
 * Azure DevOps through Microsoft Entra ID (GP-196).
 *
 * Azure DevOps' own OAuth apps are deprecated; the supported path is an Entra ID
 * app registration requesting the Azure DevOps resource scope. That suits the
 * product's Azure-first posture: a customer's Microsoft tenant grants (and
 * revokes) the access, with their own conditional-access policies applying —
 * which is what their security team will ask about first.
 *
 * It is the shared OAuth engine with different endpoints, plus two Entra
 * quirks worth naming:
 *
 *  - the tenant segment. `organizations` (the default) means "any work or
 *    school account"; a single-tenant registration puts its tenant id here.
 *  - `scope` must be repeated on refresh. Entra requires it, GitLab rejects it,
 *    hence `refreshParams` rather than always sending it.
 *
 * Azure DevOps **Server** (on-premises) is out of scope here — it has no Entra
 * tenant — and keeps using a PAT, which is why the mode never replaces `pat`.
 */
import type { EntraOAuthConfig } from "../config.js";
import type { FastifyInstance } from "fastify";

import type { IntegrationCredentialRow } from "../../db/schema.js";
import { credentialStore, registerStrategy } from "../credentials.js";
import {
  oauth2ConnectFlow,
  oauth2Strategy,
  type OAuth2Config,
  type OAuth2Http,
} from "../oauth2.js";
import type { ConnectFlow, CredentialStrategy } from "../types.js";

/**
 * The Azure DevOps resource application id — a Microsoft constant, the same in
 * every tenant. `.default` asks for the permissions the registration was
 * granted, so what we can do is decided in the customer's tenant, not here.
 */
const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

/** The profile endpoint that names who authorized (`vssps`, not `dev.azure.com`). */
const PROFILE_URL =
  "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1";

export function entraOAuthConfig(config: EntraOAuthConfig): OAuth2Config {
  const tenant = encodeURIComponent(config.tenant);
  // `offline_access` is what makes Entra issue a refresh token at all.
  const scope = `${ADO_RESOURCE_ID}/.default offline_access`;
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scope,
    refreshParams: { scope },
  };
}

type AdoProfile = { displayName?: string; emailAddress?: string };

export function azureDevOpsConnectFlow(
  config: EntraOAuthConfig,
  http: OAuth2Http,
): ConnectFlow {
  return oauth2ConnectFlow(entraOAuthConfig(config), http, async ({ tokens }) => {
    const profile = (await http.getJson(
      PROFILE_URL,
      tokens.access_token,
    )) as AdoProfile;
    const account = profile.displayName ?? profile.emailAddress ?? null;
    return {
      name: account ? `Azure DevOps · ${account}` : "Azure DevOps",
      config: { account, instanceUrl: `entra:${config.tenant}` },
    };
  });
}

export function azureDevOpsOAuthStrategy(
  app: FastifyInstance,
  row: IntegrationCredentialRow,
  config: EntraOAuthConfig,
  http: OAuth2Http,
): CredentialStrategy {
  return oauth2Strategy(app, credentialStore(app, row), entraOAuthConfig(config), http);
}

registerStrategy("azure_devops", "oauth2", (app, row) => {
  const config = app.integrations.entraOAuth;
  if (!config) {
    return {
      mode: "oauth2",
      getToken: () =>
        Promise.reject(
          new Error(
            "Azure DevOps OAuth is not configured on this instance — reconnect this repository with a token",
          ),
        ),
    };
  }
  return azureDevOpsOAuthStrategy(app, row, config, app.oauth2Http);
});
