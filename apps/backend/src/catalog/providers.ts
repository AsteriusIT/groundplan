/**
 * Which providers this deployment may extract schemas from (GP-234).
 *
 * This is the catalog's `registry.ts`: the only place that knows which providers
 * exist, so nothing downstream ever branches on a provider name. Unlike the
 * integrations registry, though, the list is a **security boundary** and not
 * just an inventory — `terraform init` downloads a provider and runs it, so an
 * un-allowlisted namespace/name reaching the extractor would be remote code
 * execution with an HTTP front door. Every path that could spawn a process
 * checks membership here first (GP-236).
 *
 * The default four match the icon coverage the canvas already ships (GP-90), so
 * a catalog resource always has something to draw.
 */

export type ProviderRef = {
  /** `hashicorp`. */
  namespace: string;
  /** `azurerm` — also the prefix its resource types carry. */
  name: string;
};

/** `hashicorp/azurerm` — how a provider is named on the wire and in logs. */
export function providerId(ref: ProviderRef): string {
  return `${ref.namespace}/${ref.name}`;
}

/**
 * `hashicorp/azurerm` → a ref. Returns null for anything that is not exactly
 * two non-empty segments of the characters a registry namespace may hold —
 * which is also what keeps a path traversal or a shell metacharacter out of the
 * temp directory and the generated `required_providers` block.
 */
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/;

export function parseProviderId(id: string): ProviderRef | null {
  const parts = id.split("/");
  if (parts.length !== 2) return null;
  const [namespace, name] = parts as [string, string];
  if (!SEGMENT.test(namespace) || !SEGMENT.test(name)) return null;
  return { namespace, name };
}

/**
 * The providers a deployment extracts unless it says otherwise. Four, chosen to
 * match the vendor icons the canvas ships — a fifth would draw as a generic box.
 */
export const DEFAULT_CATALOG_PROVIDERS: readonly string[] = [
  "hashicorp/azurerm",
  "hashicorp/aws",
  "hashicorp/google",
  "hashicorp/kubernetes",
];

/**
 * Parse `CATALOG_PROVIDERS` — a comma-separated allowlist. An entry that is not
 * a well-formed `namespace/name` is dropped rather than failing boot: a typo in
 * one entry must not take an instance down, and the dropped entry simply is not
 * allowlisted, which is the safe direction.
 */
export function parseAllowlist(
  raw: string | undefined,
  fallback: readonly string[] = DEFAULT_CATALOG_PROVIDERS,
): ProviderRef[] {
  const source = (raw ?? "").trim();
  const entries = source === "" ? fallback : source.split(",");
  const refs: ProviderRef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const ref = parseProviderId(entry.trim());
    if (!ref) continue;
    const id = providerId(ref);
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push(ref);
  }
  return refs;
}

/** Is this provider one the deployment allows? The check before any spawn. */
export function isAllowlisted(
  ref: ProviderRef,
  allowlist: readonly ProviderRef[],
): boolean {
  return allowlist.some(
    (allowed) =>
      allowed.namespace === ref.namespace && allowed.name === ref.name,
  );
}
