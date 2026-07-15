import { type ReactNode, type SyntheticEvent, useState } from "react";

import { ApiError, createProject } from "@/api/client";
import type { Project } from "@/api/types";
import { slugify } from "@/lib/format";
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

export function CreateProjectDialog({
  trigger,
  onCreated,
}: Readonly<{
  trigger: ReactNode;
  onCreated: (project: Project) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = slugify(name);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setName("");
      setError(null);
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: SyntheticEvent) {
    event.preventDefault();
    if (!slug) {
      setError("Enter a name with at least one letter or number.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject({ name: name.trim(), slug });
      onCreated(project);
      handleOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not create the project.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">New project</DialogTitle>
          <DialogDescription>
            Name your project. You can add repositories to it next.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production platform"
              autoComplete="off"
              autoFocus
            />
            <p className="text-muted-foreground text-xs">
              Slug{" "}
              <span className="text-foreground font-mono">{slug || "—"}</span>
            </p>
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={submitting || !slug}>
              {submitting ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
