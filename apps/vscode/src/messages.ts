/**
 * The message protocol between the extension host and the webview (GP-147+).
 * One file, imported by both bundles, so the two sides cannot drift.
 */
import type { Graph } from "@groundplan/graph-parser";

import type { SyncValue } from "./live-core.js";
import type { PanelPrefs } from "./panel-prefs.js";

export type { SyncValue };

/**
 * GP-154: what the diff is against. The wire owns this type — both sides use it.
 *
 * `head` is the last commit; `merge-base` is the fork point with whatever this
 * repository calls its default branch (detected, never assumed to be `main`);
 * `branch:<ref>` is the fork point with a branch the reader picked.
 *
 * A tagged string rather than an object because `mode` is compared with `===`
 * in three places that matter: the webview's re-render guard (a deep compare
 * there would remount the canvas on every keystroke), the baseline provider's
 * cache `Map` key, and the flat JSON preferences document.
 *
 * The ref is always fully qualified (`refs/heads/x`, `refs/remotes/origin/x`).
 * Short names are ambiguous — local `master` and `origin/master` are different
 * commits — and a name beginning with `-` would reach `git` as an option.
 */
export type BaselineMode = "head" | "merge-base" | `branch:${string}`;

const BRANCH_PREFIX = "branch:";

/** The mode that compares against `ref`, which must be fully qualified. */
export function branchMode(ref: string): BaselineMode {
  return `${BRANCH_PREFIX}${ref}`;
}

/** The ref a branch mode names, or null for the two fixed modes. */
export function branchRefOf(mode: BaselineMode): string | null {
  return mode.startsWith(BRANCH_PREFIX) ? mode.slice(BRANCH_PREFIX.length) : null;
}

/** A ref as a reader says it: `refs/remotes/origin/x` → `origin/x`. */
export function shortRef(ref: string): string {
  for (const prefix of ["refs/heads/", "refs/remotes/"]) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

/**
 * Ref names this extension will hand to `git`. Deliberately stricter than
 * `git check-ref-format`: an allowlist of characters, fully qualified, and
 * bounded — because the value arrives from a stored preferences document,
 * which is untrusted input whoever wrote it.
 */
const SAFE_REF = /^refs\/[A-Za-z0-9._\-/]+$/;

function isSafeRef(ref: string): boolean {
  return (
    ref.length <= 255 &&
    SAFE_REF.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.includes("/.") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".lock")
  );
}

/** Narrow untrusted input (a stored preference, a message) to a mode. */
export function isBaselineMode(value: unknown): value is BaselineMode {
  if (value === "head" || value === "merge-base") return true;
  if (typeof value !== "string" || !value.startsWith(BRANCH_PREFIX)) return false;
  return isSafeRef(value.slice(BRANCH_PREFIX.length));
}

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
  /**
   * The commit that ref resolved to, when available. A ref name alone dates
   * nothing — `origin/main` is a different diagram before and after a fetch,
   * and the status bar exists to stop a comparison being read as live.
   */
  sha: string | null;
  /** Why there is no baseline (non-git folder, no commits, no trunk…). */
  reason: string | null;
  /**
   * The branch this repository treats as its trunk, short form, or null when
   * none was found. Reported whether or not the diff is on, because the choice
   * is offered before it is enabled — and reported rather than assumed, which
   * is the whole point: a `master` repository must not be shown "main".
   */
  defaultBranch: string | null;
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
    }
  | {
      /**
       * The panel's persisted preferences for this workspace, sent once the
       * webview says it is ready. The panel restores itself from this rather
       * than starting on the defaults and flickering into place.
       */
      type: "panelPrefs";
      prefs: PanelPrefs;
    }
  | {
      /** The first-run notice's "Learn more" — open the caveat in the panel. */
      type: "openDiffInfo";
    }
  | {
      /**
       * Whether the panel is caught up with the editor. Deliberately its own
       * message: it must be posted on paths where the rendered payload has
       * not moved, which is exactly where the signature suppresses a post —
       * and a spinner started by an edit that changed nothing would otherwise
       * never be cleared.
       */
      type: "sync";
      value: SyncValue;
      /** What went wrong, when `value` is `error`. */
      message?: string;
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
      /**
       * A panel preference moved: persist it, and re-render if it was one the
       * host has a hand in (the diff). Supersedes the three `groundplan.diff.*`
       * keys, which are read once to seed this and then left alone.
       */
      type: "setPanelPrefs";
      prefs: PanelPrefs;
    }
  | {
      /**
       * Open the host's branch picker for the diff baseline. Deliberately a
       * request rather than a preference: the branch list is git's answer at
       * this instant, and one sent to the webview could only arrive stale. The
       * host shows the QuickPick, stores the choice, and the new mode returns
       * with the next `diffState`.
       */
      type: "pickDiffBase";
    };
