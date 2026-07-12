/**
 * Runtime configuration for the SPA — the single source of config truth on the
 * frontend (the counterpart to the backend's `config/env.ts`).
 *
 * Values are loaded at startup from `/config.json` (see {@link loadConfig}),
 * NOT inlined at build time. This lets one built image be deployed to any
 * environment by mounting a different `config.json`. A built-in default is used
 * when the file is missing or malformed, so dev and tests need zero setup.
 */

export type AppConfig = {
  /** API origin. `""` = same-origin — calls hit `/api` on the current host
   * (the Vite proxy in dev, the Caddy edge in prod). */
  apiUrl: string;
  /** OIDC authority (issuer URL). */
  oidcIssuer: string;
  /** OIDC client id. */
  oidcClientId: string;
  /** Optional OIDC redirect URI; when unset the app derives
   * `${window.location.origin}/callback`. */
  oidcRedirectUri?: string;
};

/** Built-in defaults — target the dockerized dev stack (backend proxy + the
 * Keycloak realm from GP-6) so `pnpm dev` and tests work out of the box. */
export const DEFAULT_CONFIG: AppConfig = {
  apiUrl: "",
  oidcIssuer: "http://localhost:8085/realms/groundplan",
  oidcClientId: "groundplan-frontend",
};

let current: AppConfig = DEFAULT_CONFIG;

/** The active config. Safe to call before {@link loadConfig} — returns the
 * defaults until the fetch resolves. */
export function getConfig(): AppConfig {
  return current;
}

/** Overwrite the active config. Used by {@link loadConfig} and by tests. */
export function setConfig(config: AppConfig): void {
  current = config;
}

/** Merge a parsed `config.json` over the defaults, keeping only known string
 * keys — unknown keys, missing keys, and wrong-typed values are ignored. */
function mergeConfig(raw: unknown): AppConfig {
  const merged: AppConfig = { ...DEFAULT_CONFIG };
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.apiUrl === "string") merged.apiUrl = obj.apiUrl;
    if (typeof obj.oidcIssuer === "string") merged.oidcIssuer = obj.oidcIssuer;
    if (typeof obj.oidcClientId === "string")
      merged.oidcClientId = obj.oidcClientId;
    if (typeof obj.oidcRedirectUri === "string")
      merged.oidcRedirectUri = obj.oidcRedirectUri;
  }
  return merged;
}

/**
 * Fetch `/config.json`, merge it over the defaults, and install it as the active
 * config. Any failure (missing file, non-2xx, network error, invalid JSON) is
 * logged and falls back to the built-in defaults so the app still boots. Call
 * once, before rendering (see `main.tsx`).
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const response = await fetch("/config.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`config.json responded ${response.status}`);
    }
    const raw: unknown = await response.json();
    setConfig(mergeConfig(raw));
  } catch (error) {
    console.warn(
      "[config] failed to load /config.json; using built-in defaults",
      error,
    );
    setConfig(DEFAULT_CONFIG);
  }
  return getConfig();
}
