/**
 * Which providers this organization can actually import from (GP-232).
 *
 * The registry says which ones *can* list repositories; the org's connections
 * say which ones are usable. Only the intersection is honest — a connected
 * provider that cannot discover would be a dead button, and a capable provider
 * with no connection has nothing to list.
 *
 * This is the whole reason the import screen stopped naming GitHub: adding an
 * adapter on the backend now changes what the UI offers, without the UI
 * learning that a provider exists.
 */
import type { Provider, ProviderCatalogEntry, ProviderConnection } from "@/api/types";

export type ImportableProvider = { id: Provider; label: string };

export function importableProviders(
  catalog: ProviderCatalogEntry[],
  connections: ProviderConnection[],
): ImportableProvider[] {
  const connected = new Set(connections.map((c) => c.provider));
  return catalog
    .filter(
      (entry) =>
        entry.capabilities.includes("repo:discover") && connected.has(entry.id),
    )
    .map((entry) => ({ id: entry.id, label: entry.label }));
}
