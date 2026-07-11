import { type FormEvent, type ReactNode, useState } from "react";

import { ApiError, updateRepository } from "@/api/client";
import type { Repository } from "@/api/types";
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

/** Replace a repository's PAT. The server re-verifies and returns the new row. */
export function EditPatDialog({
  repository,
  trigger,
  onUpdated,
}: {
  repository: Repository;
  trigger: ReactNode;
  onUpdated: (repo: Repository) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pat, setPat] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setPat("");
      setError(null);
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!pat.trim()) {
      setError("Enter a token.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const updated = await updateRepository(repository.id, {
        accessToken: pat.trim(),
      });
      onUpdated(updated);
      handleOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not update the token.",
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
          <DialogTitle className="font-display">
            {repository.accessToken ? "Replace access token" : "Add access token"}
          </DialogTitle>
          <DialogDescription>
            The token is stored encrypted and the connection is re-checked.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-pat">Access token</Label>
            <Input
              id="edit-pat"
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
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
            <Button type="submit" disabled={submitting || !pat.trim()}>
              {submitting ? "Saving…" : "Save token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
