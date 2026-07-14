/**
 * Vendored official Google Cloud product icons, used **unmodified** (rendered
 * as-is via <img>, never recoloured/altered) in the architecture diagrams this
 * app produces — see apps/frontend/ICONS.md for the usage-terms note. Only the
 * icons we map are committed under `./gcp/`; Vite bundles each as its own asset.
 * Mirrors the GP-29 Azure / GP-91 AWS modules.
 */
import { iconUrlMap } from "./icon-assets";

/** The vendored GCP icon files (clean kebab names of `./gcp/<key>.svg`). */
export type GcpIconKey =
  // compute
  | "compute-engine"
  | "cloud-functions"
  | "cloud-run"
  // network
  | "vpc"
  | "load-balancing"
  | "cloud-dns"
  | "cloud-nat"
  | "cloud-router"
  | "cloud-firewall"
  | "external-ip"
  // storage / data
  | "cloud-storage"
  | "persistent-disk"
  | "cloud-sql"
  | "firestore"
  | "bigtable"
  | "memorystore"
  | "bigquery"
  // identity / messaging
  | "iam"
  | "pubsub"
  // containers
  | "gke"
  | "artifact-registry"
  // security
  | "kms"
  | "secret-manager"
  // observability
  | "cloud-monitoring";

// Vite resolves each SVG to a hashed asset URL at build time; only the committed
// files under ./gcp are included.
const MODULES = import.meta.glob<string>("./gcp/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

const URL_BY_KEY = iconUrlMap(MODULES);

/** All vendored GCP icon keys (used by the /styleguide gallery). */
export const GCP_ICON_KEYS = [...URL_BY_KEY.keys()].sort() as GcpIconKey[];

/** The asset URL for a vendored GCP icon. */
export function gcpIconUrl(key: GcpIconKey): string | undefined {
  return URL_BY_KEY.get(key);
}
