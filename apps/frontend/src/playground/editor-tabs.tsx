/**
 * Open-file tabs (GP-245). A tab is a file you are working on; the tree is
 * every file there is. Closing a tab closes the view of a file, never the file.
 *
 * The unsaved dot compares against the draft, not against the last parse: the
 * diagram keeps up by itself now, so "is this drawn?" stopped being a question
 * and "is this saved?" is the one left.
 */
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

import { baseName, folderOf } from "./file-tree";
import { usePlayground } from "./playground-context";

export function EditorTabs() {
  const doc = usePlayground();
  if (doc.openPaths.length === 0) return null;

  return (
    <div
      className="bg-card border-border flex shrink-0 items-stretch overflow-x-auto border-b"
      aria-label="Open files"
      role="group"
    >
      {doc.openPaths.map((path) => {
        const active = path === doc.activePath;
        const folder = folderOf(path);
        const unsaved =
          doc.savedByPath.get(path) !==
          doc.files.find((f) => f.path === path)?.content;
        const error = doc.failure?.byFile.get(path);
        return (
          <div
            key={path}
            className={cn(
              "border-border group flex items-center gap-1.5 border-r pr-1",
              active ? "bg-background" : "hover:bg-accent/40",
            )}
          >
            <button
              type="button"
              onClick={() => doc.setActivePath(path)}
              aria-current={active ? "true" : undefined}
              aria-label={`Open ${path}`}
              title={path}
              className={cn(
                "flex items-center gap-1.5 border-t-2 py-1.5 pr-1 pl-3 font-mono text-xs whitespace-nowrap transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "text-muted-foreground border-transparent",
                error && "text-destructive",
              )}
            >
              {folder && (
                <span className="text-faint">{folder}/</span>
              )}
              {baseName(path)}
              {unsaved && (
                <span
                  className="bg-update size-1.5 shrink-0 rounded-full"
                  aria-hidden="true"
                />
              )}
            </button>
            <button
              type="button"
              aria-label={`Close ${path}`}
              onClick={() => doc.closeFile(path)}
              className="text-muted-foreground hover:bg-accent hover:text-foreground grid size-5 shrink-0 place-items-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
