import { useState } from "react";
import { Download } from "lucide-react";

import type { StudioFile } from "@/api/types";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { FileTree } from "@/components/ai-elements/file-tree";
import { Snippet } from "@/components/ai-elements/snippet";
import { Button } from "@/components/ui/button";
import { buildStudioZip } from "@/lib/studio-zip";

/** Where the canvas asked the code to look (GP-143's node→code jump). */
export type CodeTarget = {
  file: string;
  /** 1-based inclusive block range; null = open the file, highlight nothing. */
  range: { start: number; end: number } | null;
};

/**
 * GP-143: the read-only code panel — file tree, HCL viewer, the one-line
 * "how to use this" hint, and the zip download. In v1 the chat is the editing
 * interface; this panel never mutates a file.
 */
export function StudioCodePanel({
  files,
  target,
}: Readonly<{
  files: StudioFile[];
  /** Set by a canvas node click; changing it re-aims the viewer. */
  target: CodeTarget | null;
}>) {
  const [activePath, setActivePath] = useState<string | null>(null);
  // The last canvas jump applied — adjusted during render so a *new* jump
  // re-aims the viewer, while the user's own later file picks stand.
  const [appliedTarget, setAppliedTarget] = useState<CodeTarget | null>(null);
  if (target !== appliedTarget) {
    setAppliedTarget(target);
    if (target) setActivePath(target.file);
  }

  // Stay on the picked file, falling back to the first whenever the shown one
  // left the set (a regeneration renamed it away).
  const shownPath =
    (activePath && files.some((f) => f.path === activePath)
      ? activePath
      : null) ??
    files[0]?.path ??
    null;
  const shown = files.find((f) => f.path === shownPath) ?? null;
  const highlightRange =
    target && target.file === shownPath ? target.range : null;

  async function download() {
    const blob = await buildStudioZip(files);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "groundplan-studio.zip";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="bg-card flex h-full min-h-0 flex-col" aria-label="Generated code">
      <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-muted-foreground font-mono text-[11px] tracking-[0.12em] uppercase">
          Files ({files.length})
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void download()}
          disabled={files.length === 0}
        >
          <Download className="size-3.5" />
          Download zip
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="border-border w-44 shrink-0 overflow-y-auto border-r">
          <FileTree
            files={files.map((f) => f.path)}
            active={shownPath}
            onSelect={setActivePath}
          />
        </div>
        {shown ? (
          <CodeBlock
            key={shown.path}
            code={shown.content}
            highlightRange={highlightRange}
            className="flex-1"
          />
        ) : (
          <p className="text-muted-foreground flex-1 px-4 py-6 text-center text-sm">
            No files yet.
          </p>
        )}
      </div>

      <div className="border-border border-t px-3 py-2">
        <Snippet command="terraform init && terraform plan" />
      </div>
    </div>
  );
}
