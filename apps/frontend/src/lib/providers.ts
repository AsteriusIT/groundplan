/**
 * Git provider detection + attach-form metadata (GP-52). Mirrors the backend's
 * `services/providers.ts` detection so the chip the user sees matches what the
 * server will store when the provider is left to auto-detect.
 */
import type { Provider } from "@/api/types";

export const PROVIDERS: Provider[] = ["github", "gitlab", "azure_devops", "generic"];

/** Best-effort provider detection from a repository URL (see backend twin). */
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

export const PROVIDER_LABELS: Record<Provider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
  generic: "Generic",
};

/**
 * Static, per-provider guidance for creating a read-only access token. Text +
 * link only — no wizard, no OAuth (out of scope). `href` is empty for `generic`
 * (the token UI is host-specific).
 */
export interface PatHelp {
  /** One-line guidance naming the minimal scope needed to clone. */
  hint: string;
  /** Where to create the token, or "" when host-specific (generic). */
  href: string;
  /** Visible label for the link. */
  linkLabel: string;
}

export const PROVIDER_PAT_HELP: Record<Provider, PatHelp> = {
  github: {
    hint: "Create a fine-grained personal access token with Contents: Read for this repository.",
    href: "https://github.com/settings/personal-access-tokens",
    linkLabel: "GitHub token settings",
  },
  gitlab: {
    hint: "Create a personal access token with the read_repository scope.",
    href: "https://gitlab.com/-/user_settings/personal_access_tokens",
    linkLabel: "GitLab token settings",
  },
  azure_devops: {
    hint: "Create a personal access token with Code (Read).",
    href: "https://dev.azure.com/_usersSettings/tokens",
    linkLabel: "Azure DevOps token settings",
  },
  generic: {
    hint: "Use any HTTPS token your Git host accepts for read access.",
    href: "",
    linkLabel: "",
  },
};
