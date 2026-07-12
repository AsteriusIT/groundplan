import { UserManager, WebStorageStateStore } from "oidc-client-ts";

import { getConfig } from "@/config";

/**
 * Build the oidc-client-ts UserManager for the Authorization Code + PKCE flow.
 * Reads runtime config (loaded from /config.json at startup); the built-in
 * defaults target the dockerized Keycloak realm (GP-6) so it works out of the box.
 */
export function createUserManager(): UserManager {
  const origin = window.location.origin;
  const config = getConfig();
  return new UserManager({
    authority: config.oidcIssuer,
    client_id: config.oidcClientId,
    redirect_uri: config.oidcRedirectUri ?? `${origin}/callback`,
    post_logout_redirect_uri: origin,
    response_type: "code", // PKCE is applied automatically by the library
    scope: "openid profile email",
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
  });
}
