/**
 * Git provider detection and per-provider credential embedding (GP-51).
 *
 * Groundplan supports four providers behind one clone/verify code path. The
 * provider is auto-detected from the repository URL on attach (a user override
 * wins and is persisted). Anything we don't recognise falls back to `generic`,
 * which still clones with a valid PAT — just with no provider-specific features.
 *
 * The `Provider` union here mirrors the `repository_provider` Postgres enum in
 * `db/schema.ts`; keep the two in sync.
 */
export const PROVIDERS = ["github", "gitlab", "azure_devops", "generic"] as const;

export type Provider = (typeof PROVIDERS)[number];

/**
 * Best-effort provider detection from a repository URL. Known SaaS hosts map to
 * their provider; everything else (including self-hosted GitLab / Azure DevOps
 * Server) is `generic` until the user overrides it.
 */
export function detectProvider(url: string): Provider {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "generic";
  }
  if (host === "github.com") return "github";
  if (host === "gitlab.com") return "gitlab";
  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
    return "azure_devops";
  }
  return "generic";
}

/**
 * Username embedded in an authenticated https clone URL, per provider. The PAT
 * is always the password, so the credential form is uniform:
 * `https://{cloneUsername}:{PAT}@host/...`.
 */
const CLONE_USERNAME: Record<Provider, string> = {
  github: "x-access-token",
  gitlab: "oauth2",
  azure_devops: "pat",
  generic: "git",
};

export function cloneUsername(provider: Provider): string {
  return CLONE_USERNAME[provider];
}
