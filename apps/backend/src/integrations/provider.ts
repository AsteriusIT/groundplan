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
  CredentialMode,
  IntegrationProvider,
  ProviderId,
  PullRequestCommenter,
  RefEventSource,
  RepoReader,
} from "./types.js";

export type ProviderDefinition = {
  id: ProviderId;
  label: string;
  credentialModes: readonly CredentialMode[];
  repo: RepoReader;
  commenter?: PullRequestCommenter | null;
  checks?: CheckPublisher | null;
  refEvents?: RefEventSource | null;
  /** Hosts this provider owns, lowercased. A suffix match with a leading dot
   * covers `*.visualstudio.com`; anything else is an exact host match. */
  hosts: readonly string[];
};

/** Does `host` belong to `pattern` (exact, or `.suffix` for a wildcard)? */
function hostMatches(host: string, pattern: string): boolean {
  return pattern.startsWith(".") ? host.endsWith(pattern) : host === pattern;
}

export function defineProvider(def: ProviderDefinition): IntegrationProvider {
  const commenter = def.commenter ?? null;
  const checks = def.checks ?? null;
  const refEvents = def.refEvents ?? null;

  // Capabilities are *derived*, never declared twice: `repo:read` is the floor
  // (every provider can be cloned with a credential), the rest follow from what
  // was supplied.
  const capabilities: Capability[] = ["repo:read"];
  if (commenter) capabilities.push("pr:comment");
  if (checks) capabilities.push("check:publish");
  if (refEvents) capabilities.push("ref:events");

  return {
    id: def.id,
    label: def.label,
    credentialModes: def.credentialModes,
    capabilities,
    repo: def.repo,
    commenter,
    checks,
    refEvents,
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
  };
}
