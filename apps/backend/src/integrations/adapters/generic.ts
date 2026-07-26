/**
 * The generic adapter (GP-192): any git remote we can clone with a token and
 * nothing more. It owns no hosts (it is the fallback, never a match) and
 * declares only `repo:read` — which is how "PR comments are not available here"
 * becomes a capability check instead of a special case.
 */
import { defineProvider } from "../provider.js";
import type { IntegrationProvider, RepoReader } from "../types.js";

const repo: RepoReader = {
  cloneUsername: () => "git",
};

export function createGenericProvider(): IntegrationProvider {
  return defineProvider({
    id: "generic",
    label: "Git (generic)",
    credentialModes: ["pat"],
    hosts: [],
    repo,
  });
}
