/**
 * The catalog's place on the app (GP-235): the store, the allowlist, and the
 * clock that keeps it current.
 *
 * Shaped like the ref poller (`plugins/ref-poller.ts`) for the same reasons — a
 * plain `setInterval`, ticks that never overlap, an `unref`'d timer that cannot
 * hold the process open, and `refreshCatalogOnce` decorated regardless of the
 * interval so a tick can be driven by hand.
 *
 * What is different is the posture of the extractor. The API process gets
 * {@link refusingExtractor}: it may notice a new provider version and record
 * that one exists, but it never spawns `terraform` — extraction is the worker's
 * job (GP-236), in its own container with its own limits. An API node that
 * downloaded three hundred megabytes of provider on a whim would be an API node
 * that stops answering.
 */
import fp from "fastify-plugin";

import { parseAllowlist, type ProviderRef } from "../catalog/providers.js";
import {
  refreshCatalog,
  refusingExtractor,
  type CatalogRefreshMode,
  type ProviderRefreshOutcome,
  type SchemaExtractor,
} from "../catalog/refresh.js";
import {
  createRegistryClient,
  type RegistryClient,
} from "../catalog/registry.js";
import {
  catalogRepository,
  type CatalogRepository,
} from "../catalog/repository.js";
import { seedFromSnapshot } from "../catalog/seed.js";

declare module "fastify" {
  interface FastifyInstance {
    /** The catalog store (GP-234) — the only thing that reads the tables. */
    catalog: CatalogRepository;
    /** The providers this deployment allows extraction for (GP-234). */
    catalogAllowlist: readonly ProviderRef[];
    /** `disabled` = this instance makes no outbound catalog call at all. */
    catalogRefreshMode: CatalogRefreshMode;
    /** Run one refresh pass now (never overlaps); what tests drive. */
    refreshCatalogOnce(): Promise<ProviderRefreshOutcome[]>;
  }
}

export type CatalogPluginOptions = {
  /** Comma-separated `namespace/name` allowlist, straight from the env. */
  providers: string;
  mode: CatalogRefreshMode;
  /** How often the refresh loop runs. `0` = no timer (tests, and the worker). */
  intervalMs: number;
  /** The bundled snapshot to seed an empty catalog from. "" = no seeding. */
  snapshotPath: string;
  /** How long a registry answer is trusted. */
  ttlMs: number;
  /** Inject a registry client (tests). Defaults to the real HTTP one. */
  registry?: RegistryClient;
  /** Inject an extractor. Defaults to the one that refuses (see above). */
  extractor?: SchemaExtractor;
};

export const catalogPlugin = fp<CatalogPluginOptions>(async (app, opts) => {
  const allowlist = parseAllowlist(opts.providers);
  const repo = catalogRepository(app.db);
  const registry = opts.registry ?? createRegistryClient();
  const extractor = opts.extractor ?? refusingExtractor;

  app.decorate("catalog", repo);
  app.decorate("catalogAllowlist", allowlist);
  app.decorate("catalogRefreshMode", opts.mode);

  let running = false;
  const tick = async (): Promise<ProviderRefreshOutcome[]> => {
    if (running) return [];
    running = true;
    try {
      return await refreshCatalog({
        repo,
        registry,
        extractor,
        allowlist,
        mode: opts.mode,
        ttlMs: opts.ttlMs,
        log: app.log,
      });
    } catch (err) {
      // `refreshCatalog` does not throw; this is the belt for the day it does.
      app.log.error({ err }, "catalog refresh tick failed");
      return [];
    } finally {
      running = false;
    }
  };

  app.decorate("refreshCatalogOnce", tick);

  // Seed from the bundled snapshot (GP-239) before anything can be read, so a
  // fresh install never shows a warming catalog it has the answer to. Ready
  // after the first boot, so this is one row read from then on — and it runs
  // whatever the refresh mode is, because an air-gapped instance is precisely
  // the one that needs it.
  app.addHook("onReady", async () => {
    await seedFromSnapshot({
      path: opts.snapshotPath,
      repo,
      allowlist,
      log: app.log,
    });
  });

  if (opts.intervalMs > 0 && opts.mode !== "disabled") {
    const timer = setInterval(() => void tick(), opts.intervalMs);
    timer.unref();
    app.addHook("onClose", async () => {
      clearInterval(timer);
    });
  }
});
