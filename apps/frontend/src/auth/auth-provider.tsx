import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { User as OidcUser, UserManager } from "oidc-client-ts";

import { getMe, setAuthTokenProvider, setOnUnauthorized } from "@/api/client";
import type { User } from "@/api/types";

import { AuthContext, type AuthContextValue } from "./auth-context";
import { createUserManager } from "./user-manager";

export function AuthProvider({
  children,
  userManager,
}: Readonly<{
  children: ReactNode;
  /** Injectable for tests; defaults to the real Keycloak-backed manager. */
  userManager?: UserManager;
}>) {
  const [manager] = useState(() => userManager ?? createUserManager());
  const oidcUserRef = useRef<OidcUser | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Apply an OIDC user: cache its access token and load the backend profile.
  const applyOidcUser = useCallback(async (oidcUser: OidcUser | null) => {
    const valid = oidcUser && !oidcUser.expired ? oidcUser : null;
    oidcUserRef.current = valid;
    if (!valid) {
      setIsAuthenticated(false);
      setUser(null);
      return;
    }
    setIsAuthenticated(true);
    try {
      setUser(await getMe());
    } catch {
      // Token rejected by the API — treat as signed out.
      oidcUserRef.current = null;
      setIsAuthenticated(false);
      setUser(null);
    }
  }, []);

  // Wire the API client to this session: it reads the token synchronously and
  // notifies us on 401 so the guard can restart the OIDC sign-in.
  useEffect(() => {
    setAuthTokenProvider(() => oidcUserRef.current?.access_token ?? null);
    setOnUnauthorized(() => {
      oidcUserRef.current = null;
      setIsAuthenticated(false);
      setUser(null);
    });
  }, []);

  // Restore any existing session and react to renew/expiry events.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await manager.getUser();
        if (!cancelled) await applyOidcUser(existing);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    const onLoaded = (u: OidcUser) => void applyOidcUser(u);
    const onCleared = () => void applyOidcUser(null);
    manager.events.addUserLoaded(onLoaded);
    manager.events.addUserUnloaded(onCleared);
    manager.events.addAccessTokenExpired(onCleared);
    manager.events.addSilentRenewError(onCleared);
    return () => {
      cancelled = true;
      manager.events.removeUserLoaded(onLoaded);
      manager.events.removeUserUnloaded(onCleared);
      manager.events.removeAccessTokenExpired(onCleared);
      manager.events.removeSilentRenewError(onCleared);
    };
  }, [manager, applyOidcUser]);

  const login = useCallback(
    async (returnTo?: string) => {
      await manager.signinRedirect({
        state: { returnTo: returnTo ?? window.location.pathname },
      });
    },
    [manager],
  );

  const logout = useCallback(async () => {
    // signoutRedirect() removes the local user first, which fires UserUnloaded
    // and flips isAuthenticated to false. Left alone, <RequireAuth> would react
    // to that by starting a *sign-in* redirect that races the end-session one —
    // and when sign-in wins, Keycloak's SSO cookie survives and logs us straight
    // back in. Holding the loading state parks the guard until the browser has
    // navigated to Keycloak's end-session endpoint, so the logout actually sticks.
    setIsLoading(true);
    try {
      await manager.signoutRedirect();
    } catch (err) {
      setIsLoading(false); // redirect never happened — un-park the guard
      throw err;
    }
  }, [manager]);

  const handleCallback = useCallback(async (): Promise<string> => {
    const oidcUser = await manager.signinRedirectCallback();
    await applyOidcUser(oidcUser);
    const state = oidcUser.state as { returnTo?: string } | undefined;
    return state?.returnTo ?? "/";
  }, [manager, applyOidcUser]);

  // Re-fetch the backend profile without touching the OIDC session — used after
  // creating an org or accepting an invite changes the caller's memberships.
  const reloadUser = useCallback(async () => {
    if (!oidcUserRef.current) return;
    try {
      setUser(await getMe());
    } catch {
      // Leave the current profile in place on a transient failure.
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated,
      isLoading,
      login,
      logout,
      handleCallback,
      reloadUser,
    }),
    [user, isAuthenticated, isLoading, login, logout, handleCallback, reloadUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
