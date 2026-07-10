/**
 * Central place to read and validate environment configuration.
 * Keep this small and dependency-light; expand as real config appears.
 */

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export type AppEnv = {
  nodeEnv: "development" | "production" | "test";
  host: string;
  port: number;
  /** Origin(s) allowed to call the API, comma-separated, or "*" for any. */
  corsOrigin: string;
};

export function loadEnv(): AppEnv {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as AppEnv["nodeEnv"];

  return {
    nodeEnv,
    host: process.env.HOST ?? "0.0.0.0",
    port: readInt(process.env.PORT, 3000),
    corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  };
}
