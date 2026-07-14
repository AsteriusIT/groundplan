/**
 * Shared helper for the vendored per-provider icon sets (GP-29 Azure, GP-91 AWS,
 * GP-92 GCP, GP-93 Kubernetes). Each provider module calls `import.meta.glob`
 * with its own literal `./<provider>/*.svg` pattern — Vite requires that pattern
 * to be a static literal, so it cannot be factored out — then hands the resulting
 * module map here to be keyed by clean filename (`./aws/ec2.svg` → `ec2`).
 */
export function iconUrlMap(
  modules: Record<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [path, url] of Object.entries(modules)) {
    const key = path.slice(path.lastIndexOf("/") + 1).replace(/\.svg$/, "");
    map.set(key, url);
  }
  return map;
}
