import { useCallback, useEffect, useState } from "react";

import { getSnapshotPolicy } from "@/api/client";
import type { SnapshotPolicy } from "@/api/types";

/**
 * The policy verdict on a snapshot (GP-202/GP-203), fetched per snapshot id.
 *
 * A failure is silent and yields null: compliance is a lens on the diagram, not
 * a precondition for it — a page that refuses to draw because the engine was
 * unreachable would be worse than one that simply has no badges.
 */
export function useSnapshotPolicy(snapshotId: string | null): {
  policy: SnapshotPolicy | null;
  /** Re-read the verdict — after granting or withdrawing a waiver (GP-204). */
  reload: () => void;
} {
  const [policy, setPolicy] = useState<SnapshotPolicy | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!snapshotId) {
      setPolicy(null);
      return;
    }
    let cancelled = false;
    getSnapshotPolicy(snapshotId)
      .then((result) => {
        if (!cancelled) setPolicy(result);
      })
      .catch(() => {
        if (!cancelled) setPolicy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshotId, nonce]);

  return { policy, reload };
}
