/**
 * The AI prose card (GP-64) — used for the PR summary and, in GP-65, for the
 * docs explanation. One component, because both are the same thing: streamed
 * prose *about a snapshot*, generated on demand.
 *
 * Three rules it exists to enforce:
 *
 *  1. **It never replaces the deterministic view.** It sits beside the rule-based
 *     summary, always labelled as generated, always naming the model.
 *  2. **Generation is user-triggered.** No auto-generation on mount — tokens cost
 *     money, so a human asks for them. Prose already cached renders instantly.
 *  3. **Flag off ⇒ nothing renders.** Not a disabled button; no AI surface at all.
 */
import { useCallback, useEffect, useState } from "react";
import { useCompletion } from "@ai-sdk/react";
import { RefreshCw, Sparkles } from "lucide-react";

import { aiCompletionUrl, aiFetch, getAiGeneration } from "@/api/client";
import type { AiKind } from "@/api/types";
import { AiResponse } from "@/components/ai-response";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { useAiStatus } from "@/lib/use-ai-status";

/** Pulsing bars standing in for prose the model has not produced yet. */
function Shimmer() {
  return (
    <div className="animate-pulse space-y-1.5" aria-hidden>
      <div className="bg-muted h-2 w-full rounded-full" />
      <div className="bg-muted h-2 w-11/12 rounded-full" />
      <div className="bg-muted h-2 w-4/5 rounded-full" />
    </div>
  );
}

export function AiPanel({
  snapshotId,
  kind,
  title,
  cta,
}: {
  snapshotId: string;
  kind: AiKind;
  /** The rail heading, e.g. "AI summary". */
  title: string;
  /** The button that triggers the first generation. */
  cta: string;
}) {
  const status = useAiStatus();
  const [loadingCached, setLoadingCached] = useState(true);

  const { completion, complete, setCompletion, isLoading, error } = useCompletion({
    api: aiCompletionUrl(snapshotId, kind),
    // Our route streams plain text (not the AI SDK's data protocol), and the
    // token has to be injected — the hook owns the request, so it gets our fetch.
    streamProtocol: "text",
    fetch: aiFetch,
  });

  // Hydrate from the cache. Switching snapshots (a new plan, a different point
  // in the docs timeline) must show *that* snapshot's prose, so the effect is
  // keyed on the snapshot and clears the previous one's text first.
  useEffect(() => {
    let cancelled = false;
    setLoadingCached(true);
    setCompletion("");

    getAiGeneration(snapshotId, kind)
      .then((cached) => {
        if (cancelled) return;
        if (cached) setCompletion(cached.output);
      })
      .catch(() => {
        // No cached prose is not an error state — the Generate button is.
      })
      .finally(() => {
        if (!cancelled) setLoadingCached(false);
      });

    return () => {
      cancelled = true;
    };
  }, [snapshotId, kind, setCompletion]);

  // The prompt is built server-side from the snapshot; the body is only how we
  // ask for a fresh one.
  const generate = useCallback(
    (regenerate: boolean) => {
      void complete("", { body: { regenerate } });
    },
    [complete],
  );

  // Flag off (or not yet known) → no AI surface at all.
  if (!status?.enabled) return null;

  const streaming = isLoading;
  const hasText = completion.length > 0;

  return (
    <section className="border-border bg-panel rounded-md border p-3">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="text-primary size-3.5 shrink-0" aria-hidden />
        <span className="text-muted-foreground font-mono text-[10px] tracking-[0.1em] uppercase">
          {title}
        </span>
      </div>

      {loadingCached ? (
        <Shimmer />
      ) : (
        <>
          {hasText && <AiResponse markdown={completion} />}
          {streaming && !hasText && <Shimmer />}

          {!hasText && !streaming && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full gap-1.5"
              onClick={() => generate(false)}
            >
              <Sparkles className="size-3.5" />
              {cta}
            </Button>
          )}

          {error && (
            <p className="text-destructive mt-2 text-xs" role="alert">
              {error.message}
            </p>
          )}

          {hasText && (
            <>
              <div className="mt-3 flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={streaming}
                  onClick={() => generate(true)}
                >
                  <RefreshCw className={streaming ? "size-3.5 animate-spin" : "size-3.5"} />
                  {streaming ? "Generating…" : "Regenerate"}
                </Button>
                <CopyButton value={completion} />
              </div>

              {/* Never let this read as fact from the tool itself. */}
              <p className="text-faint mt-2 font-mono text-[10px]">
                AI-generated from the change model · {status.model}
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
