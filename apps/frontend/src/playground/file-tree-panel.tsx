/**
 * The Editor's file tree (GP-245): the draft's files, nested by the folders
 * their paths describe, with the operations a module layout needs — new file,
 * new folder, rename, delete.
 *
 * Renaming a file means renaming its *path*, so moving `main.tf` into
 * `modules/network/` is typing the new path. That is not a compromise: paths
 * are what a playground has instead of a filesystem, and hiding them behind a
 * "move" dialog would hide the one thing the Terraform parser cares about.
 */
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { buildFileTree, type TreeEntry } from "./file-tree";
import { fileIacType, NOT_IN_VIEW } from "./playground-files";
import { usePlayground } from "./playground-context";

/** What a row is being asked about: a new name, or a deletion. */
type Pending =
  | { kind: "rename"; path: string; value: string }
  | { kind: "delete"; path: string; folder: boolean }
  | null;

export function FileTreePanel() {
  const doc = usePlayground();
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const tree = buildFileTree(
    doc.files.map((f) => f.path),
    doc.emptyFolders,
  );

  const toggle = (path: string) =>
    setCollapsed((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );

  function commitRename(from: string, to: string, folder: boolean) {
    setPending(null);
    if (folder) doc.renameFolder(from, to);
    else doc.renameFile(from, to);
  }

  function renderEntry(entry: TreeEntry, depth: number) {
    const indent = { paddingLeft: `${depth * 12 + 8}px` };

    if (pending?.kind === "rename" && pending.path === entry.path) {
      return (
        <li key={entry.path} className="flex h-7 items-center" style={indent}>
          <Input
            autoFocus
            aria-label={`New name for ${entry.path}`}
            value={pending.value}
            onChange={(e) => setPending({ ...pending, value: e.target.value })}
            onBlur={() =>
              commitRename(entry.path, pending.value, entry.kind === "folder")
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitRename(entry.path, pending.value, entry.kind === "folder");
              }
              if (e.key === "Escape") setPending(null);
            }}
            className="mr-2 h-6 font-mono text-xs"
          />
        </li>
      );
    }

    if (pending?.kind === "delete" && pending.path === entry.path) {
      return (
        <li
          key={entry.path}
          className="flex h-7 items-center gap-2 pr-2 text-xs"
          style={indent}
        >
          <span className="text-muted-foreground min-w-0 flex-1 truncate">
            Delete <span className="font-mono">{entry.name}</span>
            {pending.folder && " and everything in it"}?
          </span>
          <button
            type="button"
            aria-label={`Confirm delete ${entry.path}`}
            onClick={() => {
              if (pending.folder) doc.removeFolder(entry.path);
              else doc.removeFile(entry.path);
              setPending(null);
            }}
            className="text-destructive text-xs font-medium"
          >
            Delete
          </button>
          <button
            type="button"
            aria-label="Cancel delete"
            onClick={() => setPending(null)}
            className="text-muted-foreground hover:text-foreground text-xs"
          >
            Cancel
          </button>
        </li>
      );
    }

    if (entry.kind === "folder") {
      const shut = collapsed.includes(entry.path);
      return (
        <li key={entry.path}>
          <div className="group flex h-7 items-center pr-1">
            <button
              type="button"
              onClick={() => toggle(entry.path)}
              aria-expanded={!shut}
              aria-label={entry.path}
              style={indent}
              className="text-muted-foreground hover:text-foreground flex h-full min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-xs"
            >
              {shut ? (
                <ChevronRight className="size-3.5 shrink-0" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
            <FolderMenu
              path={entry.path}
              onRename={() =>
                setPending({
                  kind: "rename",
                  path: entry.path,
                  value: entry.path,
                })
              }
              onDelete={() =>
                setPending({ kind: "delete", path: entry.path, folder: true })
              }
            />
          </div>
          {!shut && (
            <ul>
              {entry.children.map((child) => renderEntry(child, depth + 1))}
            </ul>
          )}
        </li>
      );
    }

    const fileError = doc.failure?.byFile.get(entry.path);
    const content = doc.files.find((f) => f.path === entry.path)?.content;
    const unsaved = doc.savedByPath.get(entry.path) !== content;
    // A file of the other stack stays listed — muted, not hidden: deleting it
    // because the switch moved would be data loss.
    const inView = fileIacType(entry.path) === doc.iacType;
    return (
      <li key={entry.path} className="group flex h-7 items-center pr-1">
        <button
          type="button"
          onClick={() => doc.setActivePath(entry.path)}
          aria-current={entry.path === doc.activePath ? "true" : undefined}
          aria-label={entry.path}
          style={indent}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-2 border-l-2 pr-1 text-left font-mono text-xs transition-colors",
            entry.path === doc.activePath
              ? "border-primary bg-accent text-foreground font-medium"
              : "text-muted-foreground hover:bg-accent/60 border-transparent",
            !inView && "opacity-60",
            fileError && "text-destructive",
          )}
          title={fileError ?? (inView ? undefined : NOT_IN_VIEW[doc.iacType])}
        >
          <span className="truncate">{entry.name}</span>
        </button>
        {/* Status dots live beside the button, not inside it — an aria-label
            inside would leak into its name. */}
        {fileError && (
          <span
            className="bg-destructive size-1.5 shrink-0 rounded-full"
            aria-label={`${entry.path} has a parse error`}
            title={fileError}
          />
        )}
        {unsaved && !fileError && (
          <span
            className="bg-update size-1.5 shrink-0 rounded-full"
            aria-label={`${entry.path} has unsaved changes`}
            title="Unsaved changes"
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Rename ${entry.path}`}
          onClick={() =>
            setPending({ kind: "rename", path: entry.path, value: entry.path })
          }
        >
          <Pencil className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Delete ${entry.path}`}
          onClick={() =>
            setPending({ kind: "delete", path: entry.path, folder: false })
          }
        >
          <Trash2 className="size-3" />
        </Button>
      </li>
    );
  }

  return (
    <ul className="min-h-0 flex-1 overflow-y-auto py-1">
      {tree.map((entry) => renderEntry(entry, 0))}
    </ul>
  );
}

/** A folder's operations: put something in it, rename it, delete it. */
function FolderMenu({
  path,
  onRename,
  onDelete,
}: Readonly<{
  path: string;
  onRename: () => void;
  onDelete: () => void;
}>) {
  const doc = usePlayground();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Actions for ${path}`}
        >
          <MoreHorizontal className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => doc.addFile("tf", path)}>
          <FilePlus2 className="size-4" />
          New Terraform file
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => doc.addFile("yaml", path)}>
          <FilePlus2 className="size-4" />
          New manifest
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => doc.addFolder(`${path}/new-folder`)}>
          <FolderPlus className="size-4" />
          New folder
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRename}>
          <Pencil className="size-4" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
