/**
 * Central place to read and validate environment configuration.
 * Keep this small and dependency-light; expand as real config appears.
 */

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
};

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
  };
}
