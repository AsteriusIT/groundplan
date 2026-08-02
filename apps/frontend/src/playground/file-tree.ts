/**
 * The Playground's file tree (GP-245), as data.
 *
 * A playground has no filesystem: a folder is a prefix that some file's path
 * happens to share, which is exactly what a Terraform module layout is on disk.
 * The tree is therefore *derived* from the paths — plus the folders somebody has
 * created but not yet filled, which only the editor knows about and which stop
 * existing the moment nothing is under them (a draft stores files, so an empty
 * folder has nowhere to be stored).
 */
export type TreeFile = { kind: "file"; name: string; path: string };
export type TreeFolder = {
  kind: "folder";
  name: string;
  /** The folder's own path, e.g. `modules/network`. */
  path: string;
  children: TreeEntry[];
};
export type TreeEntry = TreeFile | TreeFolder;

/** `modules/network/main.tf` → `modules/network`; a root file → `""`. */
export function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** `modules/network/main.tf` → `main.tf`. */
export function baseName(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

/** Is `path` inside `folder` (at any depth)? A folder contains itself, no. */
export function isUnder(path: string, folder: string): boolean {
  return folder === "" ? true : path.startsWith(`${folder}/`);
}

/** Folders first, then files; each alphabetical — a stable, readable order. */
function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The tree for a set of paths. `emptyFolders` are folders with nothing in them
 * yet; a folder that both lists and holds files appears once.
 */
export function buildFileTree(
  paths: readonly string[],
  emptyFolders: readonly string[] = [],
): TreeEntry[] {
  const root: TreeFolder = { kind: "folder", name: "", path: "", children: [] };

  /** Walk (creating as needed) to the folder at `segments`, from `root`. */
  function folderAt(segments: string[]): TreeFolder {
    let current = root;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const existing = current.children.find(
        (child): child is TreeFolder =>
          child.kind === "folder" && child.name === segment,
      );
      if (existing) {
        current = existing;
        continue;
      }
      const created: TreeFolder = {
        kind: "folder",
        name: segment,
        path: prefix,
        children: [],
      };
      current.children.push(created);
      current = created;
    }
    return current;
  }

  for (const folder of emptyFolders) {
    if (folder) folderAt(folder.split("/"));
  }
  for (const path of paths) {
    const segments = path.split("/");
    const name = segments.pop() ?? path;
    folderAt(segments).children.push({ kind: "file", name, path });
  }

  const sortDeep = (folder: TreeFolder) => {
    sortEntries(folder.children);
    for (const child of folder.children) {
      if (child.kind === "folder") sortDeep(child);
    }
  };
  sortDeep(root);
  return root.children;
}

/**
 * Renaming a folder is renaming every path under it — the only way a folder can
 * be renamed when folders are prefixes. Returns the path pairs to apply.
 */
export function renamedUnder(
  paths: readonly string[],
  from: string,
  to: string,
): { from: string; to: string }[] {
  return paths
    .filter((path) => isUnder(path, from))
    .map((path) => ({ from: path, to: `${to}${path.slice(from.length)}` }));
}
