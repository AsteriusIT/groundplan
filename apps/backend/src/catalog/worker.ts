/**
 * The catalog extraction worker (GP-236) — a separate process, and the only one
 * that owns a `terraform` binary.
 *
 * It is separate for two reasons that are both about blast radius. An
 * extraction downloads hundreds of megabytes and runs a third-party executable;
 * an API node doing that is an API node not answering requests. And the isolation
 * the story asks for — non-root, memory and disk caps, egress restricted to the
 * registry and the release host, no access to app secrets — is only meaningful
 * if there is a container boundary to hang it on.
 *
 * The loop itself is deliberately dull: refresh every provider, sleep, repeat.
 * Everything interesting (whether to ask, whether to extract, who wins) is in
 * `refresh.ts`, which the API shares, so the two processes cannot drift about
 * what "up to date" means. `--once` runs a single pass and exits, which is what
 * a snapshot build (GP-239) and a Kubernetes Job want.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { AppEnv } from "../config/env.js";
import { terraformExtractor } from "./extract.js";
import { parseAllowlist, providerId } from "./providers.js";
import { refreshCatalog, type ProviderRefreshOutcome } from "./refresh.js";
import { createRegistryClient } from "./registry.js";
import { catalogRepository } from "./repository.js";

/** Just enough logger to be replaceable by a test and satisfied by `console`. */
export type WorkerLog = {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

export const consoleLog: WorkerLog = {
  info: (obj, msg) => console.log(JSON.stringify({ level: "info", msg, ...asObject(obj) })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: "warn", msg, ...asObject(obj) })),
  error: (obj, msg) => console.error(JSON.stringify({ level: "error", msg, ...asObject(obj) })),
};

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => [key, item instanceof Error ? item.message : item],
    );
    return Object.fromEntries(entries);
  }
  return { detail: value };
}

export type RunWorkerOptions = {
  env: AppEnv;
  /** One pass and exit, rather than looping. */
  once?: boolean;
  log?: WorkerLog;
  /** Test seam: resolves when the worker should stop looping. */
  stop?: Promise<void>;
};

/**
 * One pass over every allowlisted provider, with the real extractor wired in.
 * Exported so a test — and the snapshot build — can drive a pass without the
 * loop, the signals or the process exit.
 */
export async function runOnce(
  opts: RunWorkerOptions & { pool: Pool },
): Promise<ProviderRefreshOutcome[]> {
  const { env } = opts;
  const log = opts.log ?? consoleLog;
  const allowlist = parseAllowlist(env.catalogProviders);

  if (env.catalogRefresh === "disabled") {
    // An air-gapped deployment (GP-239) runs no worker at all; if one is
    // started anyway it must make no outbound call, and say so rather than
    // looking like it worked.
    log.warn(
      { mode: env.catalogRefresh },
      "catalog worker: refresh is disabled — no registry call, nothing extracted",
    );
    return [];
  }

  log.info(
    {
      providers: allowlist.map(providerId),
      terraform: env.terraformBin,
      pluginCache: env.catalogPluginCacheDir,
    },
    "catalog worker: pass starting",
  );

  const outcomes = await refreshCatalog({
    repo: catalogRepository(drizzle(opts.pool)),
    registry: createRegistryClient(),
    extractor: terraformExtractor({
      allowlist,
      terraformBin: env.terraformBin,
      pluginCacheDir: env.catalogPluginCacheDir,
      timeoutMs: env.catalogExtractTimeoutMs,
      log,
    }),
    allowlist,
    mode: env.catalogRefresh,
    ttlMs: env.catalogTtlMs,
    log,
  });

  for (const outcome of outcomes) {
    log.info(outcome, "catalog worker: provider pass finished");
  }
  return outcomes;
}

const sleep = (ms: number, stop?: Promise<void>): Promise<void> =>
  Promise.race([
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
    ...(stop ? [stop] : []),
  ]);

/** The loop. Returns when `--once`, or when `stop` resolves. */
export async function runWorker(opts: RunWorkerOptions): Promise<void> {
  const log = opts.log ?? consoleLog;
  const pool = new Pool({ connectionString: opts.env.databaseUrl });
  let stopped = false;
  void opts.stop?.then(() => {
    stopped = true;
  });

  try {
    do {
      try {
        await runOnce({ ...opts, pool });
      } catch (err) {
        // A pass that blows up must not take the worker with it: the next one
        // may well succeed, and a crash loop is how a failing provider takes
        // the whole catalog offline.
        log.error({ err }, "catalog worker: pass failed");
      }
      if (opts.once || stopped) break;
      await sleep(
        Math.max(opts.env.catalogRefreshIntervalMs, 60_000),
        opts.stop,
      );
    } while (!stopped);
  } finally {
    await pool.end();
  }
}
