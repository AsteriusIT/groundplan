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
