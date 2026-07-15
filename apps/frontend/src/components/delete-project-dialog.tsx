import { type ReactNode, type SyntheticEvent, useState } from "react";

import { ApiError, deleteProject } from "@/api/client";
import type { Project } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function DeleteProjectDialog({
  project,
  trigger,
  open: controlledOpen,
  onOpenChange,
  onDeleted,
}: Readonly<{
  project: Pick<Project, "id" | "name">;
  /** Omit when opening from a menu item — drive `open` instead. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onDeleted: (id: string) => void;
}>) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = controlledOpen ?? uncontrolledOpen;
  const confirmed = confirmText.trim() === project.name;

  function handleOpenChange(next: boolean) {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
    if (!next) {
      setConfirmText("");
      setError(null);
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: SyntheticEvent) {
    event.preventDefault();
    if (!confirmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await deleteProject(project.id);
      onDeleted(project.id);
      handleOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not delete the project.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">Delete project</DialogTitle>
          <DialogDescription>
            This permanently deletes{" "}
            <span className="text-foreground font-medium">{project.name}</span>{" "}
            and every repository connected to it, along with their snapshots and
            share links. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="confirm-project-name">
              Type the project name to confirm
            </Label>
            <Input
              id="confirm-project-name"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={project.name}
              autoComplete="off"
              autoFocus
            />
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              variant="destructive"
              disabled={submitting || !confirmed}
            >
              {submitting ? "Deleting…" : "Delete project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
