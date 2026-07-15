import { useState } from "react";

import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Confirm detaching a repository. Driven from the card's overflow menu, so it is
 * controlled rather than trigger-based — a menu item unmounts as the menu closes
 * and would take an embedded trigger's dialog with it.
 */
export function DeleteRepositoryDialog({
  name,
  open,
  onOpenChange,
  onConfirm,
}: Readonly<{
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}>) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setError(null);
      setSubmitting(false);
    }
  }

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      handleOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not remove the repository.",
      );
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">Remove repository</DialogTitle>
          <DialogDescription>
            This detaches{" "}
            <span className="text-foreground font-mono font-medium">{name}</span>{" "}
            from the project and deletes its snapshots, annotations and share
            links. The repository itself is untouched.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? "Removing…" : "Remove repository"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
