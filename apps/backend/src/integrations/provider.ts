/**
 * `defineProvider` (GP-192): the one way an adapter is assembled.
 *
 * It derives `capabilities` from the capability objects actually supplied, so a
 * provider cannot claim `pr:comment` and hand back a null commenter — the
 * declaration and the implementation are the same fact. `supports()` is then a
 * lookup, which is what lets the core do feature detection instead of naming
 * providers.
 */
import type {
  Capability,
  CheckPublisher,
  ConnectFlow,
  CredentialMode,
  IntegrationProvider,
  ProviderId,
  PullRequestCommenter,
  RefEventSource,
  RepoDiscoverer,
  RepoReader,
  RepoTreeReader,
} from "./types.js";

export type ProviderDefinition = {
  id: ProviderId;
  label: string;
  credentialModes: readonly CredentialMode[];
  repo: RepoReader;
  /** Listing a connection's repositories (GP-227); omitted = cannot be asked. */
  discoverer?: RepoDiscoverer | null;
  /** Reading a repository's tree without cloning it (GP-228). */
  trees?: RepoTreeReader | null;
  commenter?: PullRequestCommenter | null;
  checks?: CheckPublisher | null;
  refEvents?: RefEventSource | null;
  /** Browser connect flows this instance can run (GP-193+); empty = PAT only. */
  connectFlows?: readonly ConnectFlow[];
  /** Hosts this provider owns, lowercased. A suffix match with a leading dot
   * covers `*.visualstudio.com`; anything else is an exact host match. */
  hosts: readonly string[];
};

/** Does `host` belong to `pattern` (exact, or `.suffix` for a wildcard)? */
function hostMatches(host: string, pattern: string): boolean {
  return pattern.startsWith(".") ? host.endsWith(pattern) : host === pattern;
}

export function defineProvider(def: ProviderDefinition): IntegrationProvider {
  const discoverer = def.discoverer ?? null;
  const trees = def.trees ?? null;
  const commenter = def.commenter ?? null;
  const checks = def.checks ?? null;
  const refEvents = def.refEvents ?? null;
  const connectFlows = def.connectFlows ?? [];

  // Capabilities are *derived*, never declared twice: `repo:read` is the floor
  // (every provider can be cloned with a credential), the rest follow from what
  // was supplied.
  const capabilities: Capability[] = ["repo:read"];
  if (discoverer) capabilities.push("repo:discover");
  if (trees) capabilities.push("repo:tree");
  if (commenter) capabilities.push("pr:comment");
  if (checks) capabilities.push("check:publish");
  if (refEvents) capabilities.push("ref:events");

  return {
    id: def.id,
    label: def.label,
    credentialModes: def.credentialModes,
    capabilities,
    repo: def.repo,
    discoverer,
    trees,
    commenter,
    checks,
    refEvents,
    connectFlows,
    matchesUrl(url) {
      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return false;
      }
      return def.hosts.some((pattern) => hostMatches(host, pattern));
    },
    supports(capability) {
      return capabilities.includes(capability);
    },
    connectFlow(mode) {
      return connectFlows.find((flow) => flow.mode === mode) ?? null;
    },
  };
}
