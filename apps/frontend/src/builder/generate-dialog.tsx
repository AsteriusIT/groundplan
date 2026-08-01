/**
 * The generation preview (GP-135): the files before they exist.
 *
 * Generating writes into the playground's file set, which is somebody's work —
 * so the code is shown first, and a name that already exists is named out loud
 * and confirmed as a replacement. There is no merge: the generator owns the
 * whole file or none of it.
 */
import { FileCode2 } from "lucide-react";
import { useState } from "react";

import type { PlaygroundFile } from "@/api/types";
import { HclEditor } from "@/components/hcl-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function GenerateDialog({
  open,
  onOpenChange,
  files,
  collisions,
  onConfirm,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: PlaygroundFile[];
  /** Generated paths that already exist in the playground's file set. */
  collisions: string[];
  onConfirm: () => void;
}>) {
  const [activePath, setActivePath] = useState<string | null>(null);
  const active = files.find((f) => f.path === activePath) ?? files[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-display">Generated Terraform</DialogTitle>
          <DialogDescription>
            {files.length} file{files.length === 1 ? "" : "s"} from what you
            composed. They go into the playground, where you edit and visualize
            them like any other file.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => setActivePath(file.path)}
              aria-current={file.path === active?.path ? "true" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs transition-colors",
                file.path === active?.path
                  ? "bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <FileCode2 className="size-3.5" />
              {file.path}
            </button>
          ))}
        </div>

        {active && (
          <div className="border-border h-80 overflow-hidden rounded-md border">
            <HclEditor
              key={active.path}
              value={active.content}
              onChange={() => {}}
              readOnly
              ariaLabel={`${active.path} preview`}
            />
          </div>
        )}

        {collisions.length > 0 && (
          <p className="text-destructive text-sm" role="alert">
            {collisions.join(", ")} already exist
            {collisions.length === 1 ? "s" : ""} in this playground and will be
            replaced. Nothing else is touched.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>
            {collisions.length > 0 ? "Replace and write" : "Write to playground"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
