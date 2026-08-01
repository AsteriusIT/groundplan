/**
 * The bundled catalog snapshot (GP-239) — what makes the dynamic refresh an
 * enhancement rather than a dependency.
 *
 * A self-hosted install may be air-gapped, or simply refuse outbound calls. It
 * still gets a builder with the full provider catalog: the release ships a
 * snapshot, the first boot imports it, and `CATALOG_REFRESH=disabled` means
 * nothing is ever fetched. The catalog is then **pinned**, and every surface
 * says pinned rather than passing it off as current (GP-238's footer).
 *
 * The format is the narrowed schemas and nothing else — no row ids, no
 * timestamps, no host. It is gzipped JSON with everything sorted, so the same
 * catalog always produces the same bytes and a release artefact can be
 * checksummed and diffed.
 *
 * Importing is deliberately *not* a merge. A snapshot is a whole provider
 * version; it is written as one, under the version it names, and a provider
 * that already has a ready version is left alone — an instance that has been
 * running for a month must not be dragged back to the version it shipped with.
 */
import { gunzipSync, gzipSync } from "node:zlib";

import type { ProviderResourceSchema } from "@groundplan/builder";

import { parseProviderId, providerId, type ProviderRef } from "./providers.js";
import type { CatalogRepository } from "./repository.js";

/** The snapshot format. `version` is the format's, not a provider's. */
export const SNAPSHOT_FORMAT = 1;

export type CatalogSnapshotProvider = {
  /** `hashicorp/azurerm`. */
  provider: string;
  /** The exact provider version these schemas were extracted from. */
  version: string;
  schemas: ProviderResourceSchema[];
};

export type CatalogSnapshot = {
  format: number;
  /** Deterministic: sorted by provider id. */
  providers: CatalogSnapshotProvider[];
};

/**
 * Everything a running instance's catalog holds, as a snapshot. Reads the
 * schemas back out of the store rather than re-extracting, so a snapshot is
 * exactly what the instance was serving.
 */
export async function exportSnapshot(
  repo: CatalogRepository,
  refs: readonly ProviderRef[],
): Promise<CatalogSnapshot> {
  const providers: CatalogSnapshotProvider[] = [];

  for (const ref of [...refs].sort((a, b) =>
    providerId(a).localeCompare(providerId(b)),
  )) {
    const ready = await repo.getLatestReadyVersion(ref);
    if (!ready) continue;

    const page = await repo.listResourceTypes(ready.versionId, {
      kind: "all",
      limit: 500,
    });
    const names = [...page.items];
    // Paged: a large provider has more types than one read returns, and a
    // snapshot missing half a provider is worse than no snapshot.
    while (names.length < page.total) {
      const next = await repo.listResourceTypes(ready.versionId, {
        kind: "all",
        limit: 500,
        offset: names.length,
      });
      if (next.items.length === 0) break;
      names.push(...next.items);
    }

    const schemas: ProviderResourceSchema[] = [];
    for (const summary of names) {
      const schema = await repo.getResourceSchema(
        ready.versionId,
        summary.type,
        summary.kind,
      );
      if (schema) schemas.push(schema);
    }
    schemas.sort((a, b) =>
      a.kind === b.kind ? a.type.localeCompare(b.type) : a.kind.localeCompare(b.kind),
    );

    providers.push({ provider: providerId(ref), version: ready.version, schemas });
  }

  return { format: SNAPSHOT_FORMAT, providers };
}

/** The bytes a snapshot is shipped as: gzipped canonical JSON. */
export function packSnapshot(snapshot: CatalogSnapshot): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"));
}

/** Read a shipped snapshot. Throws on anything that is not one. */
export function unpackSnapshot(bytes: Buffer): CatalogSnapshot {
  const parsed = JSON.parse(gunzipSync(bytes).toString("utf8")) as CatalogSnapshot;
  if (parsed.format !== SNAPSHOT_FORMAT) {
    throw new Error(
      `catalog snapshot format ${String(parsed.format)} is not ${SNAPSHOT_FORMAT}`,
    );
  }
  if (!Array.isArray(parsed.providers)) {
    throw new Error("catalog snapshot carries no providers");
  }
  return parsed;
}

export type ImportOutcome = {
  provider: string;
  version: string;
  /** `imported`, or why it was not. */
  action: "imported" | "already_ready" | "not_allowlisted";
  types: number;
};

/**
 * Seed the store from a snapshot.
 *
 * Only providers this deployment allowlists, and only where there is nothing
 * ready yet: a snapshot is a floor, never a rollback. Nothing here reaches the
 * network — that is the whole point of it existing.
 */
export async function importSnapshot(
  snapshot: CatalogSnapshot,
  deps: { repo: CatalogRepository; allowlist: readonly ProviderRef[]; now?: Date },
): Promise<ImportOutcome[]> {
  const now = deps.now ?? new Date();
  const allowed = new Set(deps.allowlist.map(providerId));
  const outcomes: ImportOutcome[] = [];

  for (const entry of snapshot.providers) {
    const ref = parseProviderId(entry.provider);
    if (!ref || !allowed.has(entry.provider)) {
      outcomes.push({
        provider: entry.provider,
        version: entry.version,
        action: "not_allowlisted",
        types: 0,
      });
      continue;
    }

    const ready = await deps.repo.getLatestReadyVersion(ref);
    if (ready) {
      // An instance that has been running for a month must not be dragged back
      // to the version its image shipped with.
      outcomes.push({
        provider: entry.provider,
        version: ready.version,
        action: "already_ready",
        types: 0,
      });
      continue;
    }

    const provider = await deps.repo.ensureProvider(ref, { allowlisted: true });
    const version = await deps.repo.ensureVersion(provider.id, entry.version);
    const claimed = await deps.repo.claimExtraction(version.id, now);
    // Losing the claim means something else is already filling this version in;
    // the snapshot has nothing to add.
    if (!claimed) {
      outcomes.push({
        provider: entry.provider,
        version: entry.version,
        action: "already_ready",
        types: 0,
      });
      continue;
    }
    await deps.repo.saveSchemas(version.id, entry.schemas, now);
    outcomes.push({
      provider: entry.provider,
      version: entry.version,
      action: "imported",
      types: entry.schemas.length,
    });
  }

  return outcomes;
}
