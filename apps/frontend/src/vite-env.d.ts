/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the backend API (empty in dev — requests go through the proxy). */
  readonly VITE_API_URL?: string;
  /** OIDC issuer/authority (defaults to the dockerized Keycloak realm). */
  readonly VITE_OIDC_ISSUER?: string;
  /** OIDC public client id. */
  readonly VITE_OIDC_CLIENT_ID?: string;
  /** OAuth redirect URI (defaults to `${origin}/callback`). */
  readonly VITE_OIDC_REDIRECT_URI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
