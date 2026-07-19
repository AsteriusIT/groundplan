/**
 * Vendored official Microsoft Azure Architecture Icons (set V24), used
 * **unmodified** (rendered as-is via <img>, never recoloured/altered) in the
 * architecture diagrams this app produces — see apps/frontend/ICONS.md for the
 * licensing note + attribution. Only the ~30 icons we map are committed under
 * `./azure/`; Vite bundles each as its own asset.
 */

/** The vendored Azure icon files (clean kebab names of `./azure/<key>.svg`). */
export type AzureIconKey =
  | "virtual-machine"
  | "vm-scale-set"
  | "virtual-network"
  | "subnet"
  | "network-security-group"
  | "load-balancer"
  | "application-gateway"
  | "kubernetes-service"
  | "container-registry"
  | "key-vault"
  | "storage-account"
  | "disk"
  | "sql-database"
  | "postgresql"
  | "mysql"
  | "cosmos-db"
  | "redis"
  | "dns-zone"
  | "log-analytics"
  | "monitor"
  | "application-insights"
  | "app-service"
  | "app-service-plan"
  | "function-app"
  | "managed-identity"
  | "role"
  | "public-ip"
  | "network-interface"
  | "resource-group"
  | "firewall"
  | "route-table";

// Vite resolves each SVG to a hashed asset URL at build time; only the committed
// files under ./azure are included.
const MODULES = import.meta.glob<string>("./azure/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

const URL_BY_KEY = new Map<string, string>();
for (const [path, url] of Object.entries(MODULES)) {
  const key = path.slice(path.lastIndexOf("/") + 1).replace(/\.svg$/, "");
  URL_BY_KEY.set(key, url);
}

/** All vendored icon keys (used by the /styleguide gallery). */
export const AZURE_ICON_KEYS = [...URL_BY_KEY.keys()].sort((a, b) =>
  a.localeCompare(b),
) as AzureIconKey[];

/** The asset URL for a vendored Azure icon. */
export function azureIconUrl(key: AzureIconKey): string | undefined {
  return URL_BY_KEY.get(key);
}
