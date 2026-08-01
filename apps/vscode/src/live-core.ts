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

/**
 * Everything the panel is told in one refresh. Anything the webview renders
 * must appear here: a field left out is a change the panel will never hear
 * about, because an unchanged signature suppresses the post.
 */
export type PostPayload = {
  snapshot: unknown;
  folder: string;
  multiRoot: boolean;
  rootDir: string;
  diff: unknown;
  outOfSync: boolean;
};

/**
 * The comparable form of that payload. Re-posting a snapshot the webview
 * already has is not free: the canvas re-runs its ELK layout on graph *object
 * identity*, so an unchanged re-post is a full re-layout for nothing — once
 * per debounced keystroke, including keystrokes inside a comment.
 */
export function postSignature(payload: PostPayload): string {
  return JSON.stringify(payload);
}

/**
 * Sends `messages` in order through `post`, checking *before each one* that
 * `generation` — the value the caller captured when it started — is still
 * `current()`. The instant another generation has taken over, the send
 * stops: neither the message that would run next, nor any after it, goes
 * out. This is the rule that keeps an overtaken refresh from interleaving
 * its stale tail into a newer run's sequence: a run superseded partway
 * through posting will already have sent whatever went out *before* the
 * newer run started, and nothing after — so the newer run's own messages
 * are always the last thing the panel hears.
 */
export async function postWhileCurrent<M>(
  generation: number,
  current: () => number,
  messages: readonly M[],
  post: (message: M) => Promise<void>,
): Promise<void> {
  for (const message of messages) {
    if (generation !== current()) return;
    await post(message);
  }
}

/**
 * Tracks the `postSignature` last confirmed sent to the webview, so a
 * `refresh()` that recomputes an identical payload can skip a free re-post.
 * Pulled out of `LivePreview` as its own primitive (rather than a raw
 * field) because the `ready` contract — "the webview holds nothing" — is a
 * rule about this state specifically, and is worth pinning with `node:test`
 * independent of the `vscode.WebviewPanel` plumbing that drives it.
 */
export type SignatureTracker = {
  /** Whether `signature` differs from what was last confirmed sent — the
   * caller re-posts only when this is true; a re-post the webview already
   * has costs the canvas a full ELK re-layout for nothing. */
  shouldPost: (signature: string) => boolean;
  /** Record that `signature` was just sent. Call only after every message
   * for it actually went out — see `postWhileCurrent`; marking it sooner
   * lets a run superseded mid-sequence claim a payload the panel only
   * half-received. */
  markSent: (signature: string) => void;
  /**
   * The webview declared it holds nothing: a first mount that missed
   * everything posted before its `message` listener existed (the bundle is
   * 2+ MB and mounts asynchronously), or a reload (dragged to another
   * editor group, `Developer: Reload Webviews`). Forget what this host
   * believes was delivered, or the next `shouldPost` wrongly answers
   * "already sent" for a webview that received nothing.
   */
  reset: () => void;
};

/** A fresh tracker: nothing has been sent yet, so the first `shouldPost` is
 * always true. */
export function createSignatureTracker(): SignatureTracker {
  let lastSignature: string | null = null;
  return {
    shouldPost: (signature) => signature !== lastSignature,
    markSent: (signature) => {
      lastSignature = signature;
    },
    reset: () => {
      lastSignature = null;
    },
  };
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

/** What the status bar says about the panel's freshness. */
export type SyncValue = "rendering" | "synced" | "error";

export type SyncReporter = {
  /** Announce that a refresh started; returns the token that settles it. */
  begin(): number;
  /** Report the outcome. A token from a run that was overtaken is ignored. */
  settle(token: number, value: "synced" | "error", message?: string): void;
};

/**
 * The panel's sync state, deduplicated and generation-guarded.
 *
 * This deliberately does not ride on the payload signature. The signature
 * suppresses a post when nothing the panel *renders* moved — which is exactly
 * the case where a spinner started by an edit would never be cleared. So the
 * sync state is its own message, sent on every path, and deduplicated here
 * instead: otherwise a typing burst is one "rendering" per keystroke.
 *
 * The token is the guard. A refresh overtaken mid-flight must not report its
 * own outcome: the panel belongs to the newer run by then, and a stale
 * "synced" would clear a spinner that is still telling the truth.
 */
export function createSyncReporter(
  post: (value: SyncValue, message?: string) => void,
): SyncReporter {
  let token = 0;
  let last: string | null = null;

  const say = (value: SyncValue, message?: string): void => {
    const said = `${value} ${message ?? ""}`;
    if (said === last) return;
    last = said;
    post(value, message);
  };

  return {
    begin() {
      token += 1;
      say("rendering");
      return token;
    },
    settle(settling, value, message) {
      if (settling !== token) return;
      say(value, message);
    },
  };
}
