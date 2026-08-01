/**
 * The catalog's store (GP-234): everything that reads or writes the four
 * `catalog_*` tables, and the only thing that does.
 *
 * Two rules shape it.
 *
 * **Reads answer from the latest `ready` version, always.** A version being
 * extracted is invisible until it succeeds, so a refresh can never degrade a
 * response — stale-while-revalidate is not a policy layered on top, it is what
 * `getLatestReadyVersion` means (GP-235).
 *
 * **The version row is the lock.** Claiming a version for extraction is a
 * conditional UPDATE, so a cluster of nodes that all notice a new provider
 * version at the same moment produces exactly one extraction and the losers get
 * `null` and carry on. No advisory lock, no queue, no second source of truth
 * about what is running.
 *
 * The tables are global — no organization column anywhere. A provider schema is
 * public information about a public artefact; tenant code only ever reads it.
 */
import { and, asc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  firstSentence,
  type ProviderResourceSchema,
  type ProviderResourceSummary,
} from "@groundplan/builder";

import {
  catalogProviders,
  catalogProviderVersions,
  catalogResourceSchemas,
  catalogResourceTypes,
  type CatalogProviderRow,
  type CatalogProviderVersionRow,
} from "../db/schema.js";
import { packSchema, unpackSchema } from "./compress.js";
import { providerId, type ProviderRef } from "./providers.js";

export type ExtractionStatus =
  CatalogProviderVersionRow["status"];

/** A provider and the version a reader will actually be served. */
export type ReadyVersion = {
  provider: ProviderRef;
  /** The row id of the version, for the reads that follow. */
  versionId: string;
  version: string;
  /** When the schemas were extracted — every surface dates what it shows. */
  extractedAt: Date;
};

/** What `listProviders` answers: the freshness of each allowlisted provider. */
export type ProviderState = {
  provider: string;
  namespace: string;
  name: string;
  allowlisted: boolean;
  /** The version being served, or null while none ever succeeded. */
  readyVersion: string | null;
  readyAt: Date | null;
  /** The latest stable version the registry watcher saw. */
  latestKnownVersion: string | null;
  lastCheckedAt: Date | null;
  /** Set when the newest attempt failed, so the UI can be honest about it. */
  lastError: string | null;
};

/** One page of resource types, with the total the filter matched. */
export type ResourceTypePage = {
  items: ProviderResourceSummary[];
  total: number;
};

export type ListResourceTypesOptions = {
  /** Substring match on the type name, case-insensitive. */
  query?: string;
  /** Resources only by default: a data source cannot be composed. */
  kind?: ProviderResourceSummary["kind"] | "all";
  limit?: number;
  offset?: number;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * How long a claimed extraction may run before another node may take it over.
 * Well beyond the worker's own wall-clock timeout (GP-236), so the only row this
 * ever reclaims is one whose process died without unwinding.
 */
export const EXTRACTION_LEASE_MS = 30 * 60 * 1000;

export type CatalogRepository = ReturnType<typeof catalogRepository>;

export function catalogRepository(db: NodePgDatabase) {
  /**
   * The provider's row, created if this is the first time it is seen, with the
   * allowlist flag brought up to date. Idempotent: the unique key is
   * `(namespace, name)`, so concurrent callers converge on one row.
   */
  async function ensureProvider(
    ref: ProviderRef,
    opts: { allowlisted: boolean },
  ): Promise<CatalogProviderRow> {
    const [row] = await db
      .insert(catalogProviders)
      .values({
        namespace: ref.namespace,
        name: ref.name,
        allowlisted: opts.allowlisted,
      })
      .onConflictDoUpdate({
        target: [catalogProviders.namespace, catalogProviders.name],
        set: { allowlisted: opts.allowlisted, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  /** The provider's row, or null when nothing ever recorded it. */
  async function findProvider(
    ref: ProviderRef,
  ): Promise<CatalogProviderRow | null> {
    const [row] = await db
      .select()
      .from(catalogProviders)
      .where(
        and(
          eq(catalogProviders.namespace, ref.namespace),
          eq(catalogProviders.name, ref.name),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Record what the registry watcher saw, and when it looked (GP-235). */
  async function recordRegistryCheck(
    providerRowId: string,
    opts: { latestVersion: string | null; checkedAt: Date },
  ): Promise<void> {
    await db
      .update(catalogProviders)
      .set({
        // A check that could not name a version still counts as a check — the
        // TTL is about how often we ask, not about how often we succeed.
        ...(opts.latestVersion === null
          ? {}
          : { latestKnownVersion: opts.latestVersion }),
        lastCheckedAt: opts.checkedAt,
        updatedAt: opts.checkedAt,
      })
      .where(eq(catalogProviders.id, providerRowId));
  }

  /** The version row, created `pending` if this version is new. Idempotent. */
  async function ensureVersion(
    providerRowId: string,
    version: string,
  ): Promise<CatalogProviderVersionRow> {
    const [row] = await db
      .insert(catalogProviderVersions)
      .values({ providerId: providerRowId, version })
      .onConflictDoUpdate({
        target: [
          catalogProviderVersions.providerId,
          catalogProviderVersions.version,
        ],
        // Touch nothing but the timestamp: a version that is already `ready`
        // must not be knocked back to `pending` by somebody noticing it again.
        set: { updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  /**
   * The version a reader is served: the newest `ready` one. Null while the
   * provider has never had a successful extraction — which the API reports as
   * warming rather than inventing an answer.
   */
  async function getLatestReadyVersion(
    ref: ProviderRef,
  ): Promise<ReadyVersion | null> {
    const [row] = await db
      .select({
        versionId: catalogProviderVersions.id,
        version: catalogProviderVersions.version,
        extractedAt: catalogProviderVersions.extractedAt,
      })
      .from(catalogProviderVersions)
      .innerJoin(
        catalogProviders,
        eq(catalogProviders.id, catalogProviderVersions.providerId),
      )
      .where(
        and(
          eq(catalogProviders.namespace, ref.namespace),
          eq(catalogProviders.name, ref.name),
          eq(catalogProviderVersions.status, "ready"),
          isNotNull(catalogProviderVersions.extractedAt),
        ),
      )
      // Newest extraction wins rather than the highest version string: a
      // rollback to an older provider is a deliberate act, and the version that
      // was extracted last is the one the operator meant to serve.
      .orderBy(sql`${catalogProviderVersions.extractedAt} desc`)
      .limit(1);

    if (!row?.extractedAt) return null;
    return {
      provider: ref,
      versionId: row.versionId,
      version: row.version,
      extractedAt: row.extractedAt,
    };
  }

  /** Every provider the catalog knows, with what it is serving. */
  async function listProviders(): Promise<ProviderState[]> {
    const rows = await db
      .select()
      .from(catalogProviders)
      .orderBy(asc(catalogProviders.namespace), asc(catalogProviders.name));

    const states: ProviderState[] = [];
    for (const row of rows) {
      const ref = { namespace: row.namespace, name: row.name };
      const ready = await getLatestReadyVersion(ref);
      const [failure] = await db
        .select({ error: catalogProviderVersions.error })
        .from(catalogProviderVersions)
        .where(
          and(
            eq(catalogProviderVersions.providerId, row.id),
            eq(catalogProviderVersions.status, "failed"),
          ),
        )
        .orderBy(sql`${catalogProviderVersions.updatedAt} desc`)
        .limit(1);

      states.push({
        provider: providerId(ref),
        namespace: row.namespace,
        name: row.name,
        allowlisted: row.allowlisted,
        readyVersion: ready?.version ?? null,
        readyAt: ready?.extractedAt ?? null,
        latestKnownVersion: row.latestKnownVersion,
        lastCheckedAt: row.lastCheckedAt,
        lastError: failure?.error ?? null,
      });
    }
    return states;
  }

  /**
   * The resource types of one extracted version, filtered and paged. Sorted by
   * name so paging is stable, and never carrying a schema — the whole reason
   * types and schemas are two tables.
   */
  async function listResourceTypes(
    versionId: string,
    opts: ListResourceTypesOptions = {},
  ): Promise<ResourceTypePage> {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(opts.offset ?? 0, 0);
    const kind = opts.kind ?? "resource";
    const query = (opts.query ?? "").trim();

    const filters = [eq(catalogResourceTypes.versionId, versionId)];
    if (kind !== "all") filters.push(eq(catalogResourceTypes.kind, kind));
    if (query !== "") {
      // Escape the LIKE metacharacters so a user searching for `_` gets the
      // underscore they typed and not "any character".
      const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
      filters.push(
        sql`${catalogResourceTypes.name} ilike ${`%${escaped}%`} escape '\\'`,
      );
    }
    const where = and(...filters);

    const [{ total } = { total: 0 }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(catalogResourceTypes)
      .where(where);

    const rows = await db
      .select({
        name: catalogResourceTypes.name,
        kind: catalogResourceTypes.kind,
        summary: catalogResourceTypes.summary,
        attributeCount: catalogResourceTypes.attributeCount,
      })
      .from(catalogResourceTypes)
      .where(where)
      .orderBy(asc(catalogResourceTypes.name), asc(catalogResourceTypes.kind))
      .limit(limit)
      .offset(offset);

    return {
      total,
      items: rows.map((row) => ({
        type: row.name,
        kind: row.kind,
        summary: row.summary,
        attributeCount: row.attributeCount,
      })),
    };
  }

  /**
   * Every resource type name of a version. Small (a few tens of kilobytes even
   * for a large provider) and needed whole: the builder's reference derivation
   * decides whether `subnet_id` means a subnet by asking whether the provider
   * has an `azurerm_subnet`, which is a question about the *whole* list.
   */
  async function listTypeNames(versionId: string): Promise<string[]> {
    const rows = await db
      .select({ name: catalogResourceTypes.name })
      .from(catalogResourceTypes)
      .where(
        and(
          eq(catalogResourceTypes.versionId, versionId),
          eq(catalogResourceTypes.kind, "resource"),
        ),
      )
      .orderBy(asc(catalogResourceTypes.name));
    return rows.map((row) => row.name);
  }

  /** One type's schema, or null when the version does not carry that type. */
  async function getResourceSchema(
    versionId: string,
    type: string,
    kind: ProviderResourceSummary["kind"] = "resource",
  ): Promise<ProviderResourceSchema | null> {
    const [row] = await db
      .select({ schema: catalogResourceSchemas.schema })
      .from(catalogResourceSchemas)
      .innerJoin(
        catalogResourceTypes,
        eq(catalogResourceTypes.id, catalogResourceSchemas.resourceTypeId),
      )
      .where(
        and(
          eq(catalogResourceTypes.versionId, versionId),
          eq(catalogResourceTypes.name, type),
          eq(catalogResourceTypes.kind, kind),
        ),
      )
      .limit(1);
    return row ? unpackSchema(row.schema) : null;
  }

  /** Several types' schemas at once — what validating a whole composition needs. */
  async function getResourceSchemas(
    versionId: string,
    types: readonly string[],
  ): Promise<Map<string, ProviderResourceSchema>> {
    const wanted = [...new Set(types)];
    if (wanted.length === 0) return new Map();
    const rows = await db
      .select({
        name: catalogResourceTypes.name,
        schema: catalogResourceSchemas.schema,
      })
      .from(catalogResourceSchemas)
      .innerJoin(
        catalogResourceTypes,
        eq(catalogResourceTypes.id, catalogResourceSchemas.resourceTypeId),
      )
      .where(
        and(
          eq(catalogResourceTypes.versionId, versionId),
          eq(catalogResourceTypes.kind, "resource"),
          inArray(catalogResourceTypes.name, wanted),
        ),
      );
    return new Map(rows.map((row) => [row.name, unpackSchema(row.schema)]));
  }

  /**
   * Claim a version for extraction, or return null because somebody else holds
   * it. The whole of single-flight (GP-235): a conditional UPDATE on a row with
   * a unique key, so the database decides the winner and there is nothing to
   * keep in sync.
   *
   * A claim older than the lease is reclaimable — that is the only way a process
   * that died mid-extraction stops blocking its version forever.
   */
  async function claimExtraction(
    versionId: string,
    now: Date,
  ): Promise<CatalogProviderVersionRow | null> {
    const staleBefore = new Date(now.getTime() - EXTRACTION_LEASE_MS);
    const [row] = await db
      .update(catalogProviderVersions)
      .set({
        status: "extracting",
        startedAt: now,
        updatedAt: now,
        attempts: sql`${catalogProviderVersions.attempts} + 1`,
      })
      .where(
        and(
          eq(catalogProviderVersions.id, versionId),
          or(
            inArray(catalogProviderVersions.status, ["pending", "failed"]),
            and(
              eq(catalogProviderVersions.status, "extracting"),
              lt(catalogProviderVersions.startedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Store what an extraction produced and mark the version `ready`, in one
   * transaction: a half-written version that reads as `ready` would serve a
   * truncated provider, which is worse than serving the previous one.
   *
   * Re-extracting replaces: the version's types are deleted first, so a type the
   * provider dropped disappears instead of lingering forever.
   */
  async function saveSchemas(
    versionId: string,
    schemas: readonly ProviderResourceSchema[],
    now: Date,
  ): Promise<number> {
    await db.transaction(async (tx) => {
      await tx
        .delete(catalogResourceTypes)
        .where(eq(catalogResourceTypes.versionId, versionId));

      // Chunked: a large provider is fifteen hundred types, and one INSERT with
      // fifteen hundred rows of gzip blobs is a needlessly large statement.
      const CHUNK = 100;
      for (let at = 0; at < schemas.length; at += CHUNK) {
        const chunk = schemas.slice(at, at + CHUNK);
        const typeRows = await tx
          .insert(catalogResourceTypes)
          .values(
            chunk.map((schema) => ({
              versionId,
              name: schema.type,
              kind: schema.kind,
              summary: firstSentence(schema.description).slice(0, 300),
              attributeCount: schema.attributes.length,
            })),
          )
          .returning({
            id: catalogResourceTypes.id,
            name: catalogResourceTypes.name,
            kind: catalogResourceTypes.kind,
          });

        const byKey = new Map(
          typeRows.map((row) => [`${row.kind}:${row.name}`, row.id]),
        );
        await tx.insert(catalogResourceSchemas).values(
          chunk.map((schema) => {
            const packed = packSchema(schema);
            return {
              resourceTypeId: byKey.get(`${schema.kind}:${schema.type}`)!,
              schema: packed.bytes,
              rawBytes: packed.rawBytes,
            };
          }),
        );
      }

      await tx
        .update(catalogProviderVersions)
        .set({
          status: "ready",
          error: null,
          extractedAt: now,
          updatedAt: now,
        })
        .where(eq(catalogProviderVersions.id, versionId));
    });
    return schemas.length;
  }

  /**
   * Record a failed extraction. The previous `ready` version keeps being served
   * — a failure is a thing that did not happen, never a thing that breaks.
   */
  async function failExtraction(
    versionId: string,
    error: string,
    now: Date,
  ): Promise<void> {
    await db
      .update(catalogProviderVersions)
      .set({
        status: "failed",
        // One line: this is read back into a log and a provider state, and a
        // stack trace in a status field is noise nobody acts on.
        error: error.split("\n")[0]?.slice(0, 500) ?? "extraction failed",
        updatedAt: now,
      })
      .where(eq(catalogProviderVersions.id, versionId));
  }

  /** The status of one version, for the orchestrator's decisions. */
  async function getVersion(
    providerRowId: string,
    version: string,
  ): Promise<CatalogProviderVersionRow | null> {
    const [row] = await db
      .select()
      .from(catalogProviderVersions)
      .where(
        and(
          eq(catalogProviderVersions.providerId, providerRowId),
          eq(catalogProviderVersions.version, version),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Is there anything at all in the catalog? What first-boot seeding asks (GP-239). */
  async function isEmpty(): Promise<boolean> {
    const [row] = await db
      .select({ id: catalogProviderVersions.id })
      .from(catalogProviderVersions)
      .where(eq(catalogProviderVersions.status, "ready"))
      .limit(1);
    return row === undefined;
  }

  return {
    ensureProvider,
    findProvider,
    recordRegistryCheck,
    ensureVersion,
    getVersion,
    getLatestReadyVersion,
    listProviders,
    listResourceTypes,
    listTypeNames,
    getResourceSchema,
    getResourceSchemas,
    claimExtraction,
    saveSchemas,
    failExtraction,
    isEmpty,
  };
}
