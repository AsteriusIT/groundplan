/**
 * First-boot seeding from the bundled snapshot (GP-239).
 *
 * A fresh install must not meet a warming catalog: the release ships the
 * schemas, so the builder is complete from the first request. The refresh, when
 * it is on, then moves it forward from there.
 *
 * Everything about this is fail-open. A missing snapshot is the normal case for
 * a development checkout and is not worth a log line above debug; an unreadable
 * one is worth a warning and nothing more. Neither can stop an instance
 * booting — the curated entries are compiled in and the builder works without
 * any of this.
 */
import { readFile } from "node:fs/promises";

import type { ProviderRef } from "./providers.js";
import type { CatalogRepository } from "./repository.js";
import { importSnapshot, unpackSnapshot, type ImportOutcome } from "./snapshot.js";

export type SeedLog = {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
};

/**
 * Import the snapshot at `path`, for every allowlisted provider that has
 * nothing ready yet. Returns what was imported — empty when there was nothing
 * to do, which is the common case on every boot after the first.
 *
 * Per provider rather than "only when the catalog is empty", deliberately:
 * adding a provider to the allowlist later should seed it from the snapshot
 * too, and a provider that has moved on is left alone either way
 * (`importSnapshot` never rolls one back).
 */
export async function seedFromSnapshot(opts: {
  path: string;
  repo: CatalogRepository;
  allowlist: readonly ProviderRef[];
  log?: SeedLog;
}): Promise<ImportOutcome[]> {
  if (opts.path === "") return [];

  // The file is looked for first, and deliberately: a checkout and a test have
  // no snapshot, and this is what keeps boot from touching the database at all
  // in the overwhelmingly common case where there is nothing to seed.
  let bytes: Buffer;
  try {
    bytes = await readFile(opts.path);
  } catch {
    return [];
  }

  try {
    const snapshot = unpackSnapshot(bytes);
    const outcomes = await importSnapshot(snapshot, {
      repo: opts.repo,
      allowlist: opts.allowlist,
    });
    const imported = outcomes.filter((o) => o.action === "imported");
    if (imported.length > 0) {
      opts.log?.info(
        {
          path: opts.path,
          providers: imported.map((o) => `${o.provider}@${o.version}`),
          types: imported.reduce((sum, o) => sum + o.types, 0),
        },
        "catalog: seeded from the bundled snapshot",
      );
    }
    return outcomes;
  } catch (err) {
    opts.log?.warn(
      { path: opts.path, err },
      "catalog: the bundled snapshot could not be read; the builder keeps its curated resources",
    );
    return [];
  }
}
