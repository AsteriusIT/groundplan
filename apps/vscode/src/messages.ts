/**
 * The message protocol between the extension host and the webview (GP-147+).
 * One file, imported by both bundles, so the two sides cannot drift.
 */
import type { Graph } from "@groundplan/graph-parser";

/** GP-154: what the diff is against. The wire owns this type — both sides use it. */
export type BaselineMode = "head" | "merge-base";

/**
 * The preview's colour theme: the near-neutral dark "carbon" (default) or the
 * light "drafting paper" — the same token sets the web app ships. Chosen via
 * the `groundplan.theme` setting, never in-panel chrome. The initial value is
 * baked into the webview HTML; a settings change reaches an open panel as a
 * host message.
 */
export type PreviewTheme = "carbon" | "light";

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
      /**
       * The entrypoint directory the parse started from, folder-relative
       * ("" = the folder root) — the `groundplan.rootDir` setting, the stack
       * being edited (follow), or auto-detection, in that order. The empty
       * state names it.
       */
      rootDir: string;
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
    }
  | {
      /** The `groundplan.theme` setting changed while the panel was open. */
      type: "theme";
      theme: PreviewTheme;
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
