/**
 * Central place to read and validate environment configuration.
 * Keep this small and dependency-light; expand as real config appears.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Default local Postgres, matching docker-compose.yml. */
const DEFAULT_DATABASE_URL =
  "postgres://groundplan:groundplan@localhost:5432/groundplan";

/**
 * In development, default OIDC to the dockerized Keycloak so the app works out
 * of the box (matching the frontend defaults) once `docker compose --profile
 * auth up` is running. Set `OIDC_ISSUER_URL=` (empty) to run dev without auth.
 * Tests and production never get these defaults (tests run unauthenticated;
 * production must configure OIDC explicitly — see buildApp's fail-closed check).
 */
const DEV_OIDC_ISSUER = "http://localhost:8085/realms/groundplan";
const DEV_OIDC_AUDIENCE = "groundplan-api";

/**
 * Fixed dev/test key so credential encryption works out of the box. NEVER used
 * in production — there `ENCRYPTION_KEY` is required (see buildApp).
 * base64 of a readable 32-byte string.
 */
const DEV_ENCRYPTION_KEY = Buffer.from(
  "groundplan-dev-encryption-key!!!",
  "utf8",
).toString("base64");

export type AppEnv = {
  nodeEnv: "development" | "production" | "test";
  host: string;
  port: number;
  /** Origin(s) allowed to call the API, comma-separated, or "*" for any. */
  corsOrigin: string;
  /** Postgres connection string. */
  databaseUrl: string;
  /** OIDC issuer URL (discovery base). Empty string = auth disabled (dev). */
  oidcIssuer: string;
  /** Expected `aud` claim of accepted access tokens. */
  oidcAudience: string;
  /** base64-encoded 32-byte key for encrypting repository PATs at rest. */
  encryptionKey: string;
  /** Directory where rendered snapshot exports (SVG/PNG) are cached (GP-37). */
  exportCacheDir: string;
  /**
   * Public origin (scheme + host) where this deployment is reachable, e.g.
   * `https://groundplan.example.com`. Used to build absolute, login-free URLs
   * in GitHub PR comments (GP-38): the embedded PNG and the "view diagram" link.
   * Empty = omit the image + link (comment carries stats + summary only).
   */
  publicBaseUrl: string;
  /**
   * Anthropic API key for the AI layer (GP-62). **This key IS the feature flag**:
   * empty = the whole AI layer is off (`/ai/status` reports disabled, the
   * generation routes 404, and the frontend renders no AI UI). Deliberately has
   * no dev default — AI costs money, so it stays off until someone opts in.
   */
  aiApiKey: string;
  /** Model the AI layer generates with. Only used when `aiApiKey` is set. */
  aiModel: string;
  /**
   * How often the ref poller runs `git ls-remote` per repository (GP-107), in
   * milliseconds. Defaults to 60s. `0` disables the background timer entirely —
   * which is what tests do, so they can drive a tick by hand with no clock.
   */
  refPollIntervalMs: number;
};

/** Sensible default model for the AI layer; override with `AI_MODEL`. */
const DEFAULT_AI_MODEL = "claude-opus-4-8";

export function loadEnv(): AppEnv {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as AppEnv["nodeEnv"];
  const isDev = nodeEnv === "development";

  return {
    nodeEnv,
    host: process.env.HOST ?? "0.0.0.0",
    port: readInt(process.env.PORT, 3000),
    corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    oidcIssuer: process.env.OIDC_ISSUER_URL ?? (isDev ? DEV_OIDC_ISSUER : ""),
    oidcAudience: process.env.OIDC_AUDIENCE ?? (isDev ? DEV_OIDC_AUDIENCE : ""),
    encryptionKey:
      process.env.ENCRYPTION_KEY ??
      (nodeEnv === "production" ? "" : DEV_ENCRYPTION_KEY),
    exportCacheDir:
      process.env.EXPORT_CACHE_DIR ?? join(tmpdir(), "groundplan-exports"),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
    aiApiKey: process.env.AI_API_KEY ?? "",
    aiModel: process.env.AI_MODEL ?? DEFAULT_AI_MODEL,
    refPollIntervalMs: readInt(process.env.REF_POLL_INTERVAL_MS, 60_000),
  };
}
