/**
 * Pure path helpers (GP-147) — no `vscode` import, so node:test can load
 * them. The parser wants repository-relative posix paths; a workspace folder
 * must produce exactly what a repo clone would.
 */

/** Vendored/generated Terraform never belongs in the diagram. */
export const TF_EXCLUDE_GLOB = "**/{.terraform,node_modules}/**";

/** Root-relative posix path, whatever separators the platform used. */
export function toPosixRelative(root: string, file: string): string {
  const norm = (p: string): string => p.replaceAll("\\", "/");
  const rootPosix = norm(root).replace(/\/+$/, "");
  const filePosix = norm(file);
  return filePosix.startsWith(`${rootPosix}/`)
    ? filePosix.slice(rootPosix.length + 1)
    : filePosix;
}

/** The directory names `TF_EXCLUDE_GLOB` hides — the same list, as a predicate. */
const EXCLUDED_SEGMENTS = new Set([".terraform", "node_modules"]);

/**
 * Is this folder-relative posix path a `.tf` file the diagram should read?
 * The glob covers `findFiles`; this covers everything that never passes a
 * glob — git's `ls-tree` output and VS Code's document events.
 */
export function isDiagramTf(path: string): boolean {
  if (!path.endsWith(".tf")) return false;
  return !path.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}
