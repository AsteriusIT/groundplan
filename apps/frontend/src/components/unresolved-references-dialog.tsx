import { ArrowRight } from "lucide-react";

import type { UnresolvedReference } from "@/api/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * The references a producer saw but could not resolve to a node — a Terraform
 * resource pointing at an address that was never parsed, a Kubernetes workload
 * mounting a ConfigMap absent from its namespace. Every producer used to *drop*
 * these; here they are readable. Off-canvas on purpose: a dangling reference is
 * not a node to draw, it is a fact about the parse, so it lives beside the
 * warnings rather than as a ghost on the diagram.
 *
 * The trigger is the link the `WarningsNotice` renders; it opens this list.
 */
export function UnresolvedReferencesDialog({
  references,
}: {
  references: UnresolvedReference[];
}) {
  if (references.length === 0) return null;

  return (
    <Dialog>
      <DialogTrigger className="underline underline-offset-2 hover:opacity-80">
        {references.length} reference{references.length === 1 ? "" : "s"} could not
        be resolved
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Unresolved references</DialogTitle>
          <DialogDescription>
            These references pointed at something not in this snapshot, so no edge
            was drawn for them. A reference above the parsed scope, a resource that
            was renamed, or an object in another namespace all look like this.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2">
          {references.map((r) => (
            <li
              key={`${r.from} ${r.ref}`}
              className="border-border bg-muted/30 rounded-md border px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
                <span className="break-all">{r.from}</span>
                <ArrowRight className="text-muted-foreground size-3 shrink-0" />
                <span className="text-impacted break-all">{r.ref}</span>
              </div>
              {r.reason && (
                <p className="text-muted-foreground mt-1 text-xs">{r.reason}</p>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
