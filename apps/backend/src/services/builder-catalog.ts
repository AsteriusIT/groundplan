/**
 * The catalog a composition is judged against (GP-238).
 *
 * The builder used to validate and generate against a dozen hand-written
 * entries. It now validates against what the provider itself says, which means
 * the definitions have to be assembled per request, from the types the graph
 * actually uses — never the whole provider, which would be fifteen hundred
 * schemas to answer a question about four.
 *
 * The curated entries still win where they exist (`mergeCatalog`), so the
 * twelve resources somebody wrote by hand keep their labels, their files and
 * their scaffold blocks.
 *
 * A provider whose catalog is still warming is reported rather than worked
 * around: a graph checked against a catalog we do not have is a graph checked
 * against nothing, and answering "looks fine" would be the one dishonest thing
 * this endpoint could do.
 */
import {
  CATALOG,
  mergeCatalog,
  resourceDefFromSchema,
  schemaKindOf,
  type BuilderGraph,
  type ResourceDef,
} from "@groundplan/builder";

import { isAllowlisted, type ProviderRef } from "../catalog/providers.js";
import type { CatalogRepository } from "../catalog/repository.js";

export type BuilderCatalog = {
  /** Curated entries plus a definition for every type the graph uses. */
  catalog: ResourceDef[];
  /** Provider name → the version the definitions came from, for the preamble. */
  versions: Record<string, string>;
  /**
   * Providers the graph needs whose catalog has never finished extracting.
   * Non-empty means the composition cannot be checked in full.
   */
  warming: string[];
};

/** The provider a type belongs to: `azurerm_subnet` → `azurerm`. */
function providerNameOf(type: string): string {
  const at = type.indexOf("_");
  return at === -1 ? type : type.slice(0, at);
}

/**
 * The definitions needed to judge one graph.
 *
 * Two round trips per provider: the type names (which the reference derivation
 * needs whole, to tell `subnet_id` pointing at a real subnet from a coincidence)
 * and the schemas of the handful of types on the canvas.
 */
export async function catalogForGraph(
  graph: BuilderGraph,
  deps: {
    /** Only what assembling a catalog reads — the rest of the repository is not its business. */
    repo: Pick<
      CatalogRepository,
      "getLatestReadyVersion" | "listTypeNames" | "getResourceSchemas"
    >;
    allowlist: readonly ProviderRef[];
  },
): Promise<BuilderCatalog> {
  const curated = new Set(CATALOG.map((def) => def.type));
  // Per provider, per kind: a node is described by its own schema, and a `data`
  // lookup's is the data source's (GP-248). The curated dozen answer for
  // resources only — there is no hand-written data source, and inventing one
  // from a resource's arguments would generate a file Terraform rejects.
  const wanted = new Map<string, { resource: Set<string>; data_source: Set<string> }>();
  for (const node of graph.nodes) {
    // A custom resource is the user's word about a type nobody described; it is
    // validated as syntax and never looked up. A curated type needs no lookup
    // either — its definition is compiled in, which is what lets the twelve go
    // on working on a deployment with no catalog at all.
    if (node.custom || node.type.trim() === "") continue;
    const kind = schemaKindOf(node);
    if (kind === "resource" && curated.has(node.type)) continue;
    const provider = providerNameOf(node.type);
    const kinds = wanted.get(provider) ?? {
      resource: new Set<string>(),
      data_source: new Set<string>(),
    };
    kinds[kind].add(node.type);
    wanted.set(provider, kinds);
  }
  // Nothing to look up: no query, and the curated catalog is the answer.
  if (wanted.size === 0) return { catalog: [...CATALOG], versions: {}, warming: [] };

  const derived: ResourceDef[] = [];
  const versions: Record<string, string> = {};
  const warming: string[] = [];

  for (const [name, kinds] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
    const ref = deps.allowlist.find((provider) => provider.name === name);
    // Not allowlisted: there is no catalog for it and there never will be. The
    // curated entries may still cover the type; if they do not, validation
    // reports it as a type the builder does not know, which is exactly true.
    if (!ref || !isAllowlisted(ref, deps.allowlist)) continue;

    const version = await deps.repo.getLatestReadyVersion(ref);
    if (!version) {
      warming.push(`${ref.namespace}/${ref.name}`);
      continue;
    }
    versions[name] = version.version;

    const [names, resources, lookups] = await Promise.all([
      deps.repo.listTypeNames(version.versionId),
      deps.repo.getResourceSchemas(version.versionId, [...kinds.resource]),
      deps.repo.getResourceSchemas(
        version.versionId,
        [...kinds.data_source],
        "data_source",
      ),
    ]);
    const known = new Set(names);
    for (const schema of [...resources.values(), ...lookups.values()]) {
      derived.push(resourceDefFromSchema(schema, known));
    }
  }

  return { catalog: mergeCatalog(derived), versions, warming };
}
