import { useEffect, useState } from "react";

import { getReconciliation } from "@/api/client";
import type { Reconciliation } from "@/api/types";

/**
 * The cloud compared with this repository's code (GP-209), or null when either
 * side is missing.
 *
 * Null is the ordinary answer, and it is what removes the lens from the
 * switcher. A reality snapshot arrives from a `push-state` the reader may never
 * have set up, and a comparison against an absent side would report the whole
 * estate as never applied — a confident lie dressed as a finding. So: no
 * snapshot, no view. A failed request is null too, for the reason the policy
 * hook gives — this is a lens on the diagram, not a precondition for it.
 */
export function useReconciliation(repositoryId: string | undefined): {
  reconciliation: Reconciliation | null;
} {
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);

  useEffect(() => {
    if (!repositoryId) {
      setReconciliation(null);
      return;
    }
    let cancelled = false;
    getReconciliation(repositoryId)
      .then((result) => {
        if (!cancelled) setReconciliation(result);
      })
      .catch(() => {
        if (!cancelled) setReconciliation(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  return { reconciliation };
}
