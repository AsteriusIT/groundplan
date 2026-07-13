/**
 * Whether the AI layer is on (GP-62), asked once per session.
 *
 * The answer is a deployment fact, not per-page state, so the in-flight promise
 * is shared at module level: every AI panel on every page reads one `/ai/status`
 * response. While it is unknown we report `null` — callers render nothing rather
 * than flashing an AI card that might be about to disappear.
 */
import { useEffect, useState } from "react";

import { getAiStatus } from "@/api/client";
import type { AiStatus } from "@/api/types";

let pending: Promise<AiStatus> | null = null;

function load(): Promise<AiStatus> {
  // A failed probe must not be cached — a transient blip would disable the AI
  // surface for the rest of the session.
  pending ??= getAiStatus().catch((err: unknown) => {
    pending = null;
    throw err;
  });
  return pending;
}

/** Test seam: forget the cached probe. */
export function resetAiStatus(): void {
  pending = null;
}

/** The AI layer's status, or null while it is still unknown. */
export function useAiStatus(): AiStatus | null {
  const [status, setStatus] = useState<AiStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        // Unreachable /ai/status is treated as "off": the product works without
        // AI, so a probe failure must never break the page it sits on.
        if (!cancelled) setStatus({ enabled: false, model: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}
