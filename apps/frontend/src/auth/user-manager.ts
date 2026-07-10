import { UserManager, WebStorageStateStore } from "oidc-client-ts";

/**
 * Build the oidc-client-ts UserManager for the Authorization Code + PKCE flow.
 * Defaults target the dockerized Keycloak realm (GP-6) so it works out of the box.
 */
export function createUserManager(): UserManager {
  const origin = window.location.origin;
  return new UserManager({
    authority:
      import.meta.env.VITE_OIDC_ISSUER ??
      "http://localhost:8085/realms/groundplan",
    client_id: import.meta.env.VITE_OIDC_CLIENT_ID ?? "groundplan-frontend",
    redirect_uri:
      import.meta.env.VITE_OIDC_REDIRECT_URI ?? `${origin}/callback`,
    post_logout_redirect_uri: origin,
    response_type: "code", // PKCE is applied automatically by the library
    scope: "openid profile email",
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
  });
}
