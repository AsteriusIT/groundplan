/**
 * Whether Build mode exists on this deployment (GP-131), asked once per
 * session — the shape of `useAiStatus`, for the same reason: it is a
 * deployment fact, not per-page state, so one probe serves every caller.
 *
 * While it is unknown we report `null`, and the playground renders no Build
 * switch rather than flashing one that may be about to vanish.
 */
import { useEffect, useState } from "react";

import { getBuilderStatus } from "@/api/client";
import type { BuilderStatus } from "@/api/types";

let pending: Promise<BuilderStatus> | null = null;

function load(): Promise<BuilderStatus> {
  // A failed probe must not be cached — a transient blip would hide the
  // builder for the rest of the session.
  pending ??= getBuilderStatus().catch((err: unknown) => {
    pending = null;
    throw err;
  });
  return pending;
}

/** Test seam: forget the cached probe. */
export function resetBuilderStatus(): void {
  pending = null;
}

/** The builder's status, or null while it is still unknown. */
export function useBuilderStatus(): BuilderStatus | null {
  const [status, setStatus] = useState<BuilderStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        // Unreachable status is read as "off": the playground works without
        // the builder, so a probe failure must never break the page.
        if (!cancelled) setStatus({ enabled: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}
