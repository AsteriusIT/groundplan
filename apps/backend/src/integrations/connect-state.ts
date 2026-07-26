/**
 * The opaque `state` of a connect flow (GP-193).
 *
 * It has to survive a round trip through the user's browser while carrying
 * things the browser must not read (which org is connecting, a PKCE verifier),
 * and it has to be unforgeable — a state an attacker can mint is a CSRF against
 * the connect endpoint. Both are solved by the encryptor we already use for
 * credentials at rest: AES-256-GCM is authenticated, so a tampered state fails
 * to decrypt rather than decoding into something.
 *
 * No table, deliberately: the state is short-lived, self-describing and
 * single-purpose, and a row would only add a cleanup job.
 */
import type { Encryptor } from "../lib/encryption.js";
import type { CredentialMode, ProviderId } from "./types.js";

/** How long a started flow stays completable. Long enough to read a consent
 * screen, short enough that a leaked URL is stale by the time it is found. */
const TTL_MS = 15 * 60 * 1000;

export type ConnectState = {
  orgId: string;
  provider: ProviderId;
  mode: CredentialMode;
  /** Whatever the flow needs back (a PKCE verifier); never seen by the browser. */
  carry: Record<string, string>;
  /** Expiry, epoch ms. */
  exp: number;
};

export function sealConnectState(
  encryptor: Encryptor,
  state: Omit<ConnectState, "exp">,
  nowMs: number = Date.now(),
): string {
  return encryptor.encrypt(JSON.stringify({ ...state, exp: nowMs + TTL_MS }));
}

/** Thrown for a state that is forged, corrupt or expired — all the same answer
 * to the caller: start the connection again. */
export class InvalidConnectStateError extends Error {
  constructor() {
    super("this connection attempt is no longer valid — start it again");
    this.name = "InvalidConnectStateError";
  }
}

export function openConnectState(
  encryptor: Encryptor,
  sealed: string,
  nowMs: number = Date.now(),
): ConnectState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encryptor.decrypt(sealed));
  } catch {
    throw new InvalidConnectStateError();
  }
  const state = parsed as Partial<ConnectState>;
  if (
    typeof state?.orgId !== "string" ||
    typeof state.provider !== "string" ||
    typeof state.mode !== "string" ||
    typeof state.exp !== "number" ||
    state.exp <= nowMs
  ) {
    throw new InvalidConnectStateError();
  }
  return {
    orgId: state.orgId,
    provider: state.provider,
    mode: state.mode,
    carry: state.carry ?? {},
    exp: state.exp,
  };
}
