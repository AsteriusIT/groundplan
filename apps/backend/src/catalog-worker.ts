/**
 * The catalog extraction worker's entrypoint (GP-236).
 *
 * Deliberately tiny, and deliberately not `index.ts`: this process serves no
 * HTTP, holds no OIDC configuration and needs none of the app's collaborators.
 * It connects to Postgres, runs `terraform` against generated empty configs,
 * and writes schemas. Everything it does lives in `catalog/worker.ts`.
 *
 * `--once` runs a single pass and exits (a Kubernetes Job, or a snapshot build).
 */
import "dotenv/config";

import { runWorker } from "./catalog/worker.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
const once = process.argv.includes("--once");

let requestStop: (() => void) | undefined;
const stop = new Promise<void>((resolve) => {
  requestStop = resolve;
});

// A signal ends the loop after the pass in flight, rather than killing an
// extraction halfway and leaving a claimed version behind for the lease to
// reclaim.
process.on("SIGINT", () => requestStop?.());
process.on("SIGTERM", () => requestStop?.());

await runWorker({ env, once, stop });
