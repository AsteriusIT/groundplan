/**
 * Resource icon resolution chain (GP-29, extended GP-91 AWS). Pure and
 * unit-tested:
 *
 *   exact vendor type  →  vendor type-prefix heuristic  →  category icon
 *   (GP-24)  →  generic cube.
 *
 * Each provider tries its own glyphs only for its own types (`azurerm_*` →
 * Azure, `aws_*` → AWS); any other provider skips straight to the category icon,
 * then the generic cube. Adding a provider is a new `<provider>.ts` map + a
 * branch here.
 */
import { categorize, type Category } from "../lib/resource-category";
import type { AzureIconKey } from "../icons/azure-icons";
import { AZURERM_ICON_MAP, AZURERM_PREFIX_MAP } from "../icons/azurerm";
import type { AwsIconKey } from "../icons/aws-icons";
import { AWS_ICON_MAP, AWS_PREFIX_MAP } from "../icons/aws";
import type { GcpIconKey } from "../icons/gcp-icons";
import { GCP_ICON_MAP, GCP_PREFIX_MAP } from "../icons/gcp";
import type { KubernetesIconKey } from "../icons/kubernetes-icons";
import {
  KUBERNETES_ICON_MAP,
  KUBERNETES_PREFIX_MAP,
} from "../icons/kubernetes";

export type IconResolution =
  | { kind: "azure"; icon: AzureIconKey }
  | { kind: "aws"; icon: AwsIconKey }
  | { kind: "gcp"; icon: GcpIconKey }
  | { kind: "kubernetes"; icon: KubernetesIconKey }
  | { kind: "category"; category: Exclude<Category, "other"> }
  | { kind: "generic" };

/** Prefix keys sorted longest-first, so the most specific prefix wins. */
function sortedByLengthDesc(map: Record<string, unknown>): string[] {
  return Object.keys(map).sort((a, b) => b.length - a.length);
}

/** Exact type → icon, else longest matching type-prefix → icon, else undefined. */
function lookupIcon<K extends string>(
  type: string,
  exact: Record<string, K>,
  prefixes: Record<string, K>,
  sortedPrefixes: string[],
): K | undefined {
  const hit = exact[type];
  if (hit) return hit;
  for (const prefix of sortedPrefixes) {
    if (type === prefix || type.startsWith(`${prefix}_`)) {
      return prefixes[prefix];
    }
  }
  return undefined;
}

const AZURERM_SORTED = sortedByLengthDesc(AZURERM_PREFIX_MAP);
const AWS_SORTED = sortedByLengthDesc(AWS_PREFIX_MAP);
const GCP_SORTED = sortedByLengthDesc(GCP_PREFIX_MAP);
const KUBERNETES_SORTED = sortedByLengthDesc(KUBERNETES_PREFIX_MAP);

/**
 * Kubernetes has two key spaces in one table: Terraform types (`kubernetes_*`,
 * matched exactly then by prefix for versioned variants) and bare native kinds
 * (`Deployment`, matched exactly only). Bare kinds are PascalCase, so they never
 * collide with a snake_case Terraform type from another provider.
 */
function resolveKubernetes(type: string): KubernetesIconKey | undefined {
  if (type.startsWith("kubernetes_")) {
    return lookupIcon(
      type,
      KUBERNETES_ICON_MAP,
      KUBERNETES_PREFIX_MAP,
      KUBERNETES_SORTED,
    );
  }
  return KUBERNETES_ICON_MAP[type];
}

export function resolveResourceIcon(type: string): IconResolution {
  if (type.startsWith("azurerm_")) {
    const icon = lookupIcon(
      type,
      AZURERM_ICON_MAP,
      AZURERM_PREFIX_MAP,
      AZURERM_SORTED,
    );
    if (icon) return { kind: "azure", icon };
  }
  if (type.startsWith("aws_")) {
    const icon = lookupIcon(type, AWS_ICON_MAP, AWS_PREFIX_MAP, AWS_SORTED);
    if (icon) return { kind: "aws", icon };
  }
  if (type.startsWith("google_") || type.startsWith("google-beta_")) {
    // `google-beta` aliases share the same terraform type names — normalise the
    // provider prefix so both flow through one table.
    const normalised = type.replace(/^google-beta_/, "google_");
    const icon = lookupIcon(
      normalised,
      GCP_ICON_MAP,
      GCP_PREFIX_MAP,
      GCP_SORTED,
    );
    if (icon) return { kind: "gcp", icon };
  }
  const k8sIcon = resolveKubernetes(type);
  if (k8sIcon) return { kind: "kubernetes", icon: k8sIcon };
  const category = categorize(type);
  if (category !== "other") return { kind: "category", category };
  return { kind: "generic" };
}
