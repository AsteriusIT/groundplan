import { FileCode2, Folder } from "lucide-react";

import { cn } from "@/lib/utils";

type TreeEntry = {
  /** Full path for files; directory prefix for folders. */
  path: string;
  name: string;
  depth: number;
  kind: "dir" | "file";
};

/** Flatten sorted paths into an indented dir/file list — no state, no fold. */
function entriesOf(paths: string[]): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const seenDirs = new Set<string>();
  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const segments = path.split("/");
    segments.slice(0, -1).forEach((dir, i) => {
      const prefix = segments.slice(0, i + 1).join("/");
      if (!seenDirs.has(prefix)) {
        seenDirs.add(prefix);
        entries.push({ path: prefix, name: dir, depth: i, kind: "dir" });
      }
    });
    entries.push({
      path,
      name: segments.at(-1) ?? path,
      depth: segments.length - 1,
      kind: "file",
    });
  }
  return entries;
}

/**
 * The generated project's file list (GP-140/GP-143): directories indent,
 * files select. Small by construction (a studio project is a handful of
 * files), so no folding.
 */
export function FileTree({
  files,
  active,
  onSelect,
  className,
}: Readonly<{
  files: string[];
  active?: string | null;
  onSelect: (path: string) => void;
  className?: string;
}>) {
  return (
    <ul aria-label="Generated files" className={cn("py-1", className)}>
      {entriesOf(files).map((entry) => (
        <li key={entry.path}>
          {entry.kind === "dir" ? (
            <span
              className="text-muted-foreground flex h-7 items-center gap-1.5 pr-2 font-mono text-xs"
              style={{ paddingLeft: `${12 + entry.depth * 14}px` }}
            >
              <Folder className="size-3.5 shrink-0" />
              {entry.name}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onSelect(entry.path)}
              aria-current={entry.path === active ? "true" : undefined}
              className={cn(
                "flex h-7 w-full items-center gap-1.5 border-l-2 pr-2 text-left font-mono text-xs transition-colors",
                entry.path === active
                  ? "border-primary bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/60 border-transparent",
              )}
              style={{ paddingLeft: `${12 + entry.depth * 14}px` }}
            >
              <FileCode2 className="size-3.5 shrink-0" />
              <span className="truncate">{entry.name}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
