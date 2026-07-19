/**
 * The message protocol between the extension host and the webview (GP-147+).
 * One file, imported by both bundles, so the two sides cannot drift.
 */
import type { Graph } from "@groundplan/graph-parser";

/** GP-154: what the diff is against. The wire owns this type — both sides use it. */
export type BaselineMode = "head" | "merge-base";

/**
 * GP-154: everything the webview needs to render diff mode honestly: the
 * user's persisted choices (echoed back so a reopened panel restores them),
 * whether a baseline actually resolved, the ref name for the caption, and
 * whether the diff came back clean.
 */
export type DiffState = {
  enabled: boolean;
  mode: BaselineMode;
  changedOnly: boolean;
  /** Meaningful when enabled: did a baseline resolve? */
  available: boolean;
  /** The ref the snapshot is diffed against (caption text), when available. */
  ref: string | null;
  /** Why there is no baseline (non-git folder, no commits, no main…). */
  reason: string | null;
  /** True when the diff found nothing — all noop, no ghosts. */
  clean: boolean;
};

/** Host → webview. */
export type HostMessage =
  | {
      type: "snapshot";
      snapshot: Graph;
      /** The workspace folder previewed, and whether others were ignored. */
      folder: string;
      multiRoot: boolean;
    }
  | {
      /** GP-148: the last parse failed — the graph shown is the last good one. */
      type: "outOfSync";
      value: boolean;
    }
  | {
      /** GP-149: cursor → node. Select (or clear) from the editor side. */
      type: "select";
      address: string | null;
    }
  | {
      /** GP-154: diff-mode status; accompanies every snapshot. */
      type: "diffState";
      state: DiffState;
    };

/** Webview → host. */
export type WebviewMessage =
  | { type: "ready" }
  | {
      /** GP-149: node → code. The user clicked a node (null = cleared). */
      type: "nodeSelected";
      address: string | null;
    }
  | {
      /** GP-154: the toolbar changed a diff preference; host persists + rediffs. */
      type: "setDiffPrefs";
      enabled: boolean;
      mode: BaselineMode;
      changedOnly: boolean;
    };
