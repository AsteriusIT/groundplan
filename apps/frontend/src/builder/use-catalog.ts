/**
 * The builder's catalog, in the browser (GP-238).
 *
 * Three rules shape it.
 *
 * **Search is the server's job.** A large provider has fifteen hundred resource
 * types; the picker asks for the twenty-five that match what was typed, and the
 * browser never holds the list. That is also why there is no virtualised
 * thousand-row list here — the fix for "too many rows to render" was to stop
 * fetching them.
 *
 * **Schemas load one at a time, on selection.** A schema is the expensive read;
 * a type nobody opens costs nothing. Loaded definitions are cached under the
 * provider version they came from, so a refresh that lands a new version
 * invalidates exactly what it should and nothing else.
 *
 * **The curated dozen are always available.** They come from
 * `@groundplan/builder` with no network at all, so Build mode works on the first
 * frame, works while the catalog is warming, and works on a deployment that
 * never enabled the catalog worker. The full provider is an enlargement of a
 * builder that already functions, never a prerequisite for one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CATALOG,
  mergeCatalog,
  resourceDefFromSchema,
  type ProviderResourceSummary,
  type ResourceDef,
  type SchemaResourceKind,
} from "@groundplan/builder";

import {
  getCatalogProviders,
  getCatalogResourceSchema,
  listCatalogResources,
} from "@/api/client";
import type { CatalogProvider, CatalogProviders } from "@/api/types";

/** How many matches a search asks for. A picker nobody scrolls needs no more. */
export const SEARCH_LIMIT = 25;

/** How a definition is keyed while it loads and once it is cached. */
export function catalogKey(
  type: string,
  kind: SchemaResourceKind = "resource",
): string {
  return `${kind}:${type}`;
}

export type CatalogState = {
  /** Null while the providers are still being asked for. */
  providers: CatalogProviders | null;
  /** The provider the picker is searching, or null when there is none ready. */
  active: CatalogProvider | null;
  /** Every definition the builder can currently compose with. */
  defs: ResourceDef[];
  /** True when a provider is configured but has never finished extracting. */
  warming: boolean;
  /** True when this deployment pins its catalog and makes no outbound call. */
  pinned: boolean;
  /** Set when the catalog could not be read at all — the builder still works. */
  unavailable: boolean;
  /** Search the active provider's types. Empty query = the curated entries. */
  search: (query: string) => Promise<ProviderResourceSummary[]>;
  /**
   * The definition of a type, fetching its schema if this is the first time it
   * is asked for. Null means the type cannot be composed right now — the caller
   * declines to add a node rather than opening a form with nothing in it.
   *
   * It answers with the definition rather than a flag on purpose: the caller
   * needs it *in that tick*, and waiting for React to re-render with the new
   * catalog would add a node the ops layer still could not describe.
   *
   * The kind is part of the question (GP-248): `data_source` asks for the
   * arguments that identify an existing one, which are not the resource's, and
   * null there means this type has no data source — or that no catalog is
   * configured to say. Either way the answer is the same: it cannot be looked
   * up here, and the form says so rather than inventing a schema.
   */
  ensure: (
    type: string,
    kind?: SchemaResourceKind,
  ) => Promise<ResourceDef | null>;
  /**
   * Which definitions are currently being fetched, for a spinner on the entry.
   * Keyed `<kind>:<type>` — see {@link loadingType}.
   */
  loading: ReadonlySet<string>;
};

/** The provider the builder composes against: the first one that is ready. */
function activeProvider(providers: CatalogProviders | null): CatalogProvider | null {
  return providers?.providers.find((p) => p.status === "ready") ?? null;
}

/**
 * Every resource type name of a provider, paged until there are none left.
 *
 * The reference derivation needs the list *whole*: `subnet_id` is a connection
 * precisely because the provider has an `azurerm_subnet`, and a partial list
 * would silently turn real connections into text boxes. Names only, so it is
 * tens of kilobytes even for a large provider, and it is fetched once per
 * session per provider version.
 */
async function fetchTypeNames(provider: string): Promise<Set<string>> {
  const names = new Set<string>();
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const page = await listCatalogResources(provider, { limit: PAGE, offset });
    for (const resource of page.resources) names.add(resource.type);
    if (names.size >= page.total || page.resources.length === 0) break;
  }
  return names;
}

export function useCatalog(): CatalogState {
  const [providers, setProviders] = useState<CatalogProviders | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [schemas, setSchemas] = useState<Map<string, ResourceDef>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  // Which provider version the cached definitions came from. A new version
  // means the definitions are about a different provider, so they go.
  const cachedVersion = useRef<string | null>(null);
  // In-flight fetches, so two clicks on the same entry are one request.
  const pending = useRef(new Map<string, Promise<ResourceDef | null>>());
  // The provider's whole type list, fetched once and shared by every schema.
  const names = useRef<Promise<Set<string>> | null>(null);

  /** The type list, fetched at most once per provider version. */
  const typeNames = useCallback((provider: string): Promise<Set<string>> => {
    names.current ??= fetchTypeNames(provider).catch((err: unknown) => {
      // A failed list must not be cached: it would turn every connection on
      // every later type into a text box for the rest of the session.
      names.current = null;
      throw err;
    });
    return names.current;
  }, []);

  useEffect(() => {
    let cancelled = false;
    getCatalogProviders()
      .then((value) => {
        if (!cancelled) setProviders(value);
      })
      .catch(() => {
        // A catalog nobody can reach is not a broken builder: the curated
        // entries are compiled in, so Build mode carries on with those.
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const active = activeProvider(providers);
  const version = active?.version ?? null;

  useEffect(() => {
    if (cachedVersion.current === version) return;
    cachedVersion.current = version;
    pending.current.clear();
    names.current = null;
    setSchemas(new Map());
  }, [version]);

  const search = useCallback(
    async (query: string): Promise<ProviderResourceSummary[]> => {
      if (!active) return [];
      const page = await listCatalogResources(active.provider, {
        q: query,
        limit: SEARCH_LIMIT,
      });
      return page.resources;
    },
    [active],
  );

  const ensure = useCallback(
    async (
      type: string,
      kind: SchemaResourceKind = "resource",
    ): Promise<ResourceDef | null> => {
      // Curated first: those need no network, ever. They are resources — there
      // is no hand-written data source, and a lookup always asks the provider.
      const curated =
        kind === "resource" ? CATALOG.find((def) => def.type === type) : undefined;
      if (curated) return curated;
      const key = catalogKey(type, kind);
      const cached = schemas.get(key);
      if (cached) return cached;
      if (!active) return null;

      const inFlight = pending.current.get(key);
      if (inFlight) return inFlight;

      const load = (async () => {
        setLoading((current) => new Set(current).add(key));
        try {
          const [{ schema }, known] = await Promise.all([
            getCatalogResourceSchema(active.provider, type, kind),
            typeNames(active.provider),
          ]);
          const def = resourceDefFromSchema(schema, known);
          setSchemas((current) => new Map(current).set(key, def));
          return def;
        } catch {
          return null;
        } finally {
          setLoading((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
          pending.current.delete(key);
        }
      })();

      pending.current.set(key, load);
      return load;
    },
    [active, schemas, typeNames],
  );

  const defs = useMemo(
    () => mergeCatalog([...schemas.values()], CATALOG),
    [schemas],
  );

  return {
    providers,
    active,
    defs,
    warming: Boolean(
      providers?.providers.some((p) => p.status === "warming") && !active,
    ),
    pinned: providers?.refresh === "disabled",
    unavailable,
    search,
    ensure,
    loading,
  };
}
