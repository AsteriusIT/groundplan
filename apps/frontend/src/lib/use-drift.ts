import { useCallback, useEffect, useState } from "react";

import { getRepositoryDrift } from "@/api/client";
import type { DriftState } from "@/api/types";

/**
 * The repository's newest drift measurement (GP-207), or null when nobody has
 * run one.
 *
 * Null is the normal answer, not an error state: drift is opt-in, it arrives
 * from a cron job the reader may never have set up, and a docs page that
 * complained about its absence would be nagging about a feature rather than
 * drawing a diagram. A failed request is null too, for the reason the policy
 * hook gives: drift is a lens on the diagram, not a precondition for it.
 */
export function useRepositoryDrift(repositoryId: string | undefined): {
  drift: DriftState | null;
  reload: () => void;
} {
  const [drift, setDrift] = useState<DriftState | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!repositoryId) {
      setDrift(null);
      return;
    }
    let cancelled = false;
    getRepositoryDrift(repositoryId)
      .then((result) => {
        if (!cancelled) setDrift(result);
      })
      .catch(() => {
        if (!cancelled) setDrift(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repositoryId, nonce]);

  return { drift, reload };
}
