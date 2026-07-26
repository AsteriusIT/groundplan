/**
 * Git provider identity (GP-51) — now a thin re-export of the integration
 * registry (GP-192).
 *
 * The knowledge that used to live here (which hosts belong to which provider,
 * which username pairs with the token in a clone URL) moved into the adapters,
 * where a provider's every fact sits together. This module survives as the
 * stable import path for the rest of the backend and as the place the
 * `repository_provider` Postgres enum is mirrored.
 */
export { cloneUsername, detectProvider } from "../integrations/registry.js";

/** `PROVIDERS` mirrors the `repository_provider` Postgres enum; keep in sync. */
export { PROVIDER_IDS as PROVIDERS } from "../integrations/types.js";
export type { ProviderId as Provider } from "../integrations/types.js";
