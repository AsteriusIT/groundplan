/**
 * What the integration adapters need from the environment (GP-193+).
 *
 * Pulled out of `AppEnv` into its own narrow shape so an adapter depends on the
 * three values it uses, not on the whole application config — and so a test can
 * build a fully-configured GitHub App without inventing a database URL.
 *
 * Every field is optional in effect: an empty value means "not configured on
 * this instance", which the provider reports honestly (the mode disappears from
 * the catalog) rather than failing at boot. That is the `AI_API_KEY` posture,
 * applied to integrations.
 */
import type { AppEnv } from "../config/env.js";

export type GitHubAppConfig = {
  appId: string;
  /** PEM private key. Present together with `appId` or the App is off. */
  privateKey: string;
  /** URL slug, for `github.com/apps/{slug}/installations/new`. */
  slug: string;
  /** Webhook signing secret (GP-194); empty disables webhook ingestion. */
  webhookSecret: string;
};

/**
 * A registered OAuth 2.0 application (GP-195/196/197). One per provider per
 * deployment; empty client credentials mean "not configured on this instance".
 */
export type OAuth2AppConfig = {
  clientId: string;
  clientSecret: string;
};

/** GitLab OAuth, plus the instance the application is registered on (GP-195). */
export type GitLabOAuthConfig = OAuth2AppConfig & { instanceUrl: string };

export type IntegrationsConfig = {
  githubApp: GitHubAppConfig | null;
  gitlabOAuth: GitLabOAuthConfig | null;
  /** Public origin the provider redirects back to; "" = flows unavailable. */
  publicBaseUrl: string;
};

/** Is this GitHub App configuration complete enough to use? */
export function githubAppFrom(env: AppEnv): GitHubAppConfig | null {
  if (!env.githubAppId || !env.githubAppPrivateKey) return null;
  return {
    appId: env.githubAppId,
    privateKey: env.githubAppPrivateKey,
    slug: env.githubAppSlug,
    webhookSecret: env.githubAppWebhookSecret,
  };
}

/** GitLab OAuth is on only when both halves of the client credential are set. */
export function gitlabOAuthFrom(env: AppEnv): GitLabOAuthConfig | null {
  if (!env.gitlabOauthClientId || !env.gitlabOauthClientSecret) return null;
  return {
    clientId: env.gitlabOauthClientId,
    clientSecret: env.gitlabOauthClientSecret,
    instanceUrl: env.gitlabUrl,
  };
}

export function integrationsConfigFrom(env: AppEnv): IntegrationsConfig {
  return {
    githubApp: githubAppFrom(env),
    gitlabOAuth: gitlabOAuthFrom(env),
    publicBaseUrl: env.publicBaseUrl,
  };
}

/** Nothing configured — the default every existing deployment already has. */
export const NO_INTEGRATIONS_CONFIG: IntegrationsConfig = {
  githubApp: null,
  gitlabOAuth: null,
  publicBaseUrl: "",
};
