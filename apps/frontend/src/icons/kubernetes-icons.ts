/**
 * Vendored Kubernetes community icons (the `kubernetes/community` icon set — the
 * recognisable blue heptagon kind glyphs), used **unmodified** (rendered as-is
 * via <img>, never recoloured/altered) in the architecture diagrams this app
 * produces — see apps/frontend/ICONS.md for the CC-BY-4.0 attribution. Only the
 * kinds we map are committed under `./kubernetes/`; Vite bundles each as its own
 * asset. Mirrors the GP-29 Azure / GP-91 AWS / GP-92 GCP modules.
 */
import { iconUrlMap } from "./icon-assets";

/** The vendored Kubernetes icon files (clean kebab names of `./kubernetes/<key>.svg`). */
export type KubernetesIconKey =
  // workloads
  | "pod"
  | "deployment"
  | "replica-set"
  | "stateful-set"
  | "daemon-set"
  | "job"
  | "cron-job"
  | "horizontal-pod-autoscaler"
  // networking
  | "service"
  | "ingress"
  | "network-policy"
  // config
  | "config-map"
  | "secret"
  // storage
  | "persistent-volume"
  | "persistent-volume-claim"
  // RBAC / identity
  | "service-account"
  | "role"
  | "cluster-role"
  | "role-binding"
  | "cluster-role-binding"
  // cluster
  | "namespace"
  | "node";

// Vite resolves each SVG to a hashed asset URL at build time; only the committed
// files under ./kubernetes are included.
const MODULES = import.meta.glob<string>("./kubernetes/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

const URL_BY_KEY = iconUrlMap(MODULES);

/** All vendored Kubernetes icon keys (used by the /styleguide gallery). */
export const KUBERNETES_ICON_KEYS = [
  ...URL_BY_KEY.keys(),
].sort() as KubernetesIconKey[];

/** The asset URL for a vendored Kubernetes icon. */
export function kubernetesIconUrl(key: KubernetesIconKey): string | undefined {
  return URL_BY_KEY.get(key);
}
