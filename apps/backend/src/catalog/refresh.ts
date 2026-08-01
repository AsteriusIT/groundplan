/**
 * Keeping the catalog current (GP-235), without ever making a user wait.
 *
 * The whole orchestration is three decisions, in this order:
 *
 * 1. **Should we ask the registry at all?** Only if the TTL since the last check
 *    has expired, or if we have never checked. Cheap, but not free, and there is
 *    no reason for a hundred nodes to ask a hundred times an hour.
 * 2. **Is there something new?** A version we do not already serve.
 * 3. **May we be the one to extract it?** The version row is the lock
 *    (`claimExtraction`); losing means somebody else is already on it, which is
 *    the correct outcome and not an error.
 *
 * Nothing here throws. A refresh that fails leaves the previous `ready` version
 * being served and records why — the product's rule that a measurement failing
 * is a thing that did not happen, never a thing that breaks. A registry nobody
 * can reach simply means step 1 answers "we still know what we knew".
 *
 * The expensive half is behind a port. This module never spawns a process: it
 * decides *that* an extraction should happen and hands the decision to a
 * `SchemaExtractor` (GP-236), which in the API process is deliberately one that
 * refuses — extraction belongs to the worker, not to a request handler's host.
 */
import type { FastifyBaseLogger } from "fastify";

import type { ProviderResourceSchema } from "@groundplan/builder";

import { isAllowlisted, providerId, type ProviderRef } from "./providers.js";
import { isNewer, latestStable, type RegistryClient } from "./registry.js";
import type { CatalogRepository } from "./repository.js";

/**
 * What turns a provider version into schemas. Implemented for real by the
 * extraction worker (GP-236); the API process gets {@link refusingExtractor}.
 */
export type SchemaExtractor = {
  extract(
    ref: ProviderRef,
    version: string,
  ): Promise<readonly ProviderResourceSchema[]>;
};

/**
 * The extractor of a process that must not extract. It is not a no-op: it
 * *fails*, loudly and in the version's error column, because a silent no-op
 * would leave a version `pending` forever with nothing saying why.
 */
export const refusingExtractor: SchemaExtractor = {
  extract() {
    return Promise.reject(
      new Error(
        "schema extraction does not run in this process — see the catalog worker",
      ),
    );
  },
};

/** How the deployment wants the catalog kept up to date. */
export type CatalogRefreshMode = "auto" | "disabled";

export type RefreshOptions = {
  repo: CatalogRepository;
  registry: RegistryClient;
  extractor: SchemaExtractor;
  allowlist: readonly ProviderRef[];
  /** `disabled` = never any outbound call; the catalog is whatever is stored. */
  mode: CatalogRefreshMode;
  /** How long a registry answer is trusted before asking again. */
  ttlMs: number;
  /** Injected so tests need no clock. */
  now?: () => Date;
  log?: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
};

/** What one pass over one provider did — the shape the tests assert on. */
export type ProviderRefreshOutcome =
  /** The TTL had not expired; nothing was asked and nothing was done. */
  | { provider: string; action: "skipped_fresh" }
  /** Refresh is off on this deployment: no outbound call was made. */
  | { provider: string; action: "skipped_disabled" }
  /** The registry could not be reached; what is stored keeps being served. */
  | { provider: string; action: "registry_unreachable"; error: string }
  /** Asked, and the newest stable version is one we already serve. */
  | { provider: string; action: "up_to_date"; version: string }
  /** Somebody else holds the claim on this version. */
  | { provider: string; action: "already_running"; version: string }
  /** Extracted and stored. */
  | { provider: string; action: "extracted"; version: string; types: number }
  /** Claimed it, and it failed. The previous ready version is untouched. */
  | { provider: string; action: "failed"; version: string; error: string };

/**
 * Has the registry answer for this provider gone stale? `null` (never checked)
 * counts as stale — the first tick after a boot is what fills an empty catalog.
 */
export function shouldCheckRegistry(
  lastCheckedAt: Date | null,
  now: Date,
  ttlMs: number,
): boolean {
  if (lastCheckedAt === null) return true;
  return now.getTime() - lastCheckedAt.getTime() >= ttlMs;
}

/**
 * How long to wait before retrying a version that failed: exponential in the
 * number of attempts, capped. A provider that is broken upstream must not be
 * re-downloaded every tick, and the cap is what stops a long-broken one from
 * drifting into "never retried again".
 */
export function retryDelayMs(attempts: number, ttlMs: number): number {
  const backoff = ttlMs * 2 ** Math.max(attempts - 1, 0);
  return Math.min(backoff, ttlMs * 8);
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** One provider, one pass. Never throws. */
export async function refreshProvider(
  ref: ProviderRef,
  opts: RefreshOptions,
): Promise<ProviderRefreshOutcome> {
  const id = providerId(ref);
  const now = (opts.now ?? (() => new Date()))();
  const allowed = isAllowlisted(ref, opts.allowlist);

  // The row is kept even for a provider that has fallen out of the allowlist,
  // with the flag cleared: its schemas stay readable, and nothing new is fetched.
  const provider = await opts.repo.ensureProvider(ref, { allowlisted: allowed });
  if (!allowed || opts.mode === "disabled") {
    return { provider: id, action: "skipped_disabled" };
  }

  if (!shouldCheckRegistry(provider.lastCheckedAt, now, opts.ttlMs)) {
    return { provider: id, action: "skipped_fresh" };
  }

  let versions: readonly string[];
  try {
    versions = await opts.registry.listVersions(ref);
  } catch (err) {
    // Deliberately *not* recorded as a check: an unreachable registry must not
    // start the TTL, or a blip would mean waiting hours before trying again.
    opts.log?.warn(
      { provider: id, err },
      "catalog: registry unreachable, serving what is stored",
    );
    return { provider: id, action: "registry_unreachable", error: message(err) };
  }

  const latest = latestStable(versions);
  await opts.repo.recordRegistryCheck(provider.id, {
    latestVersion: latest,
    checkedAt: now,
  });
  if (latest === null) {
    return { provider: id, action: "up_to_date", version: "" };
  }

  const ready = await opts.repo.getLatestReadyVersion(ref);
  if (ready && !isNewer(latest, ready.version)) {
    return { provider: id, action: "up_to_date", version: ready.version };
  }

  const version = await opts.repo.ensureVersion(provider.id, latest);
  if (version.status === "ready") {
    return { provider: id, action: "up_to_date", version: latest };
  }
  if (
    version.status === "failed" &&
    version.updatedAt.getTime() + retryDelayMs(version.attempts, opts.ttlMs) >
      now.getTime()
  ) {
    // Backing off from a version that keeps failing. Reported as "running" would
    // be a lie; it is simply not this tick's turn.
    return { provider: id, action: "already_running", version: latest };
  }

  const claimed = await opts.repo.claimExtraction(version.id, now);
  if (!claimed) {
    return { provider: id, action: "already_running", version: latest };
  }

  try {
    const schemas = await opts.extractor.extract(ref, latest);
    const stored = await opts.repo.saveSchemas(version.id, schemas, new Date());
    opts.log?.info(
      { provider: id, version: latest, types: stored },
      "catalog: provider version extracted",
    );
    return { provider: id, action: "extracted", version: latest, types: stored };
  } catch (err) {
    await opts.repo.failExtraction(version.id, message(err), new Date());
    opts.log?.error(
      { provider: id, version: latest, err },
      "catalog: extraction failed, previous version still served",
    );
    return {
      provider: id,
      action: "failed",
      version: latest,
      error: message(err),
    };
  }
}

/**
 * One pass over every allowlisted provider, in order and one at a time.
 * Sequential on purpose: an extraction downloads hundreds of megabytes and
 * spawns a process, and doing four at once is how a worker container gets
 * killed for memory rather than finishing three of them.
 */
export async function refreshCatalog(
  opts: RefreshOptions,
): Promise<ProviderRefreshOutcome[]> {
  const outcomes: ProviderRefreshOutcome[] = [];
  for (const ref of opts.allowlist) {
    outcomes.push(await refreshProvider(ref, opts));
  }
  return outcomes;
}
