/**
 * The provider registry (GP-192) — the single place that knows which providers
 * exist. Every other file asks the registry for a provider and then talks to it
 * through the ports; adding a provider is a new adapter plus one line here.
 *
 * The REST clients are injected (they are `buildApp` decorations, stubbed in
 * tests), so a registry is cheap to build and an app can have its own. The
 * module-level default registry exists for the two call sites that are pure
 * functions with no Fastify instance in reach — URL detection and the clone
 * username — neither of which touches a client.
 */
import {
  realAzureDevOpsClient,
  type AzureDevOpsClient,
} from "../services/azure-devops.js";
import { realGitHubClient, type GitHubClient } from "../services/github.js";
import { realGitLabClient, type GitLabClient } from "../services/gitlab.js";
import { createAzureDevOpsProvider } from "./adapters/azure-devops.js";
import { createGenericProvider } from "./adapters/generic.js";
import { createGitHubProvider } from "./adapters/github.js";
import {
  realGitHubAppClient,
  type GitHubAppClient,
} from "./adapters/github-app.js";
import { createGitLabProvider } from "./adapters/gitlab.js";
import { realOAuth2Http, type OAuth2Http } from "./oauth2.js";
import { NO_INTEGRATIONS_CONFIG, type IntegrationsConfig } from "./config.js";
import type {
  Capability,
  CredentialMode,
  IntegrationProvider,
  ProviderId,
} from "./types.js";

export type ProviderClients = {
  github: GitHubClient;
  gitlab: GitLabClient;
  azureDevOps: AzureDevOpsClient;
  /** App-level GitHub calls (GP-193); defaults to the real client. */
  githubApp?: GitHubAppClient;
  /** Token exchange + refresh for the OAuth providers (GP-195). */
  oauth2Http?: OAuth2Http;
  /** What this deployment configured (apps, OAuth clients). Default: nothing. */
  config?: IntegrationsConfig;
};

export interface ProviderRegistry {
  /** Every registered provider, in listing order (generic last). */
  list(): IntegrationProvider[];
  get(id: ProviderId): IntegrationProvider;
  /** Providers holding a capability — the UI and the core both filter this way. */
  withCapability(capability: Capability): IntegrationProvider[];
  /** Which provider owns this URL; `generic` when nobody claims the host. */
  detect(url: string): ProviderId;
}

export function createProviderRegistry(clients: ProviderClients): ProviderRegistry {
  const config = clients.config ?? NO_INTEGRATIONS_CONFIG;
  const oauth2Http = clients.oauth2Http ?? realOAuth2Http;
  const providers: IntegrationProvider[] = [
    createGitHubProvider(
      clients.github,
      config,
      clients.githubApp ?? realGitHubAppClient,
    ),
    createGitLabProvider(clients.gitlab, config, oauth2Http),
    createAzureDevOpsProvider(clients.azureDevOps),
    createGenericProvider(),
  ];
  const byId = new Map(providers.map((p) => [p.id, p]));

  return {
    list: () => [...providers],
    get(id) {
      const provider = byId.get(id);
      // Unreachable through the type system; a loud throw beats a silent null
      // if a new pg enum value ever lands without its adapter.
      if (!provider) throw new Error(`no adapter registered for provider: ${id}`);
      return provider;
    },
    withCapability: (capability) => providers.filter((p) => p.supports(capability)),
    detect(url) {
      return providers.find((p) => p.matchesUrl(url))?.id ?? "generic";
    },
  };
}

/** Registry over the real REST clients, for pure call sites (see the header). */
let defaultRegistry: ProviderRegistry | undefined;

export function providerRegistry(): ProviderRegistry {
  defaultRegistry ??= createProviderRegistry({
    github: realGitHubClient,
    gitlab: realGitLabClient,
    azureDevOps: realAzureDevOpsClient,
  });
  return defaultRegistry;
}

/**
 * Best-effort provider detection from a repository URL (GP-51's rule, now owned
 * by the adapters): each provider is asked whether it recognises the host, and
 * anything unclaimed — including self-hosted GitLab and Azure DevOps Server —
 * is `generic` until the user overrides it.
 */
export function detectProvider(url: string): ProviderId {
  return providerRegistry().detect(url);
}

/**
 * Username to pair with the token in an authenticated https clone URL. Defaults
 * to `pat` because that is what every existing repository uses; the App/OAuth
 * modes pass their own.
 */
export function cloneUsername(
  provider: ProviderId,
  mode: CredentialMode = "pat",
): string {
  return providerRegistry().get(provider).repo.cloneUsername(mode);
}
