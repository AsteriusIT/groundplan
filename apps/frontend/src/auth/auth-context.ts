import { createContext } from "react";

import type { User } from "@/api/types";

export interface AuthContextValue {
  /** The backend user (from GET /me), or null when not signed in. */
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Redirect to the IdP to sign in; `returnTo` is restored after callback. */
  login: (returnTo?: string) => Promise<void>;
  /** Clear the session and hit the IdP end-session endpoint. */
  logout: () => Promise<void>;
  /** Complete the code exchange on the /callback route; returns where to go. */
  handleCallback: () => Promise<string>;
  /** Re-fetch GET /me — e.g. after joining/creating an org changes memberships. */
  reloadUser: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
