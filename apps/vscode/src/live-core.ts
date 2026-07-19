/**
 * The live-update loop's pure core (GP-148) — no `vscode` import, so
 * node:test covers the decisions: when the last-good graph is kept, how
 * parser diagnostics land in the Problems panel, and how a typing burst
 * collapses to one re-parse.
 */
import type { Diagnostic } from "@groundplan/graph-parser";

/**
 * The last-good contract: an `error` diagnostic means a file dropped out of
 * the snapshot entirely (mid-edit syntax states, mostly) — keep the graph the
 * reader has and mark it out of sync. Warnings ride along with a good parse.
 */
export function hasParseErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/** One Problems-panel entry, in editor coordinates (0-based lines). */
export type FileDiagnostic = {
  startLine: number;
  endLine: number;
  message: string;
  severity: "error" | "warning";
};

/**
 * Group diagnostics by file, converting the parser's 1-based inclusive line
 * spans to 0-based. A diagnostic without a file (an empty terraform root) has
 * no line to sit on — it stays out of the Problems panel; the out-of-sync
 * indicator and the panel itself carry that story.
 */
export function toFileDiagnostics(
  diagnostics: Diagnostic[],
): Map<string, FileDiagnostic[]> {
  const byFile = new Map<string, FileDiagnostic[]>();
  for (const d of diagnostics) {
    if (!d.file) continue;
    const entry: FileDiagnostic = {
      startLine: Math.max(0, (d.range?.start_line ?? 1) - 1),
      endLine: Math.max(0, (d.range?.end_line ?? 1) - 1),
      message: d.message,
      severity: d.severity,
    };
    const bucket = byFile.get(d.file);
    if (bucket) bucket.push(entry);
    else byFile.set(d.file, [entry]);
  }
  return byFile;
}

export type Debouncer = {
  schedule: () => void;
  dispose: () => void;
};

/** Trailing-edge debounce: a burst of edits becomes one re-parse. */
export function createDebouncer(fn: () => void, delayMs: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  return {
    schedule() {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
