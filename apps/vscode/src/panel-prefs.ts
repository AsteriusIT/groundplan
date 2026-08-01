/**
 * What the panel remembers per workspace, and how to read it back safely.
 *
 * Stored as one versioned document rather than a key per preference, so the
 * shape can move without leaving a scatter of half-migrated keys behind. The
 * three keys GP-154 wrote are seeded in on first read: a reader who had diff
 * mode on yesterday should not find it off today because the storage changed.
 *
 * Nothing here trusts what it reads. A stored document is untyped input — from
 * an older build, a newer one, or a hand-edited workspace file — and every
 * field falls back on its own. In particular the filters fall back to *hiding
 * nothing*: the failure mode worth avoiding is a panel that silently shows less
 * of the estate than the workspace holds.
 */
import type { BaselineMode } from "./messages.js";

export const PANEL_PREFS_KEY = "groundplan.panelState.v1";

export type PanelLens = "infra" | "network" | "iam";

/** Filter exclusions, as arrays — a Set does not survive JSON. */
export type PanelFilterPrefs = {
  change: string[];
  categories: string[];
  modules: string[];
  hubEdges: boolean;
};

export type PanelPrefs = {
  version: 1;
  lens: PanelLens;
  diff: { enabled: boolean; mode: BaselineMode; changedOnly: boolean };
  filters: PanelFilterPrefs;
  followCursor: boolean;
};

const LENSES: readonly PanelLens[] = ["infra", "network", "iam"];
const MODES: readonly BaselineMode[] = ["head", "merge-base"];

export const DEFAULT_PANEL_PREFS: PanelPrefs = {
  version: 1,
  lens: "infra",
  diff: { enabled: false, mode: "head", changedOnly: false },
  filters: { change: [], categories: [], modules: [], hubEdges: false },
  followCursor: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string") ? [...value] : null;
}

function readFilters(value: unknown): PanelFilterPrefs {
  if (!isRecord(value)) return DEFAULT_PANEL_PREFS.filters;
  const change = strings(value.change);
  const categories = strings(value.categories);
  const modules = strings(value.modules);
  // All or nothing: a half-read exclusion set would hide an arbitrary subset
  // with no way for the reader to tell what is missing.
  if (change === null || categories === null || modules === null) {
    return DEFAULT_PANEL_PREFS.filters;
  }
  return {
    change,
    categories,
    modules,
    hubEdges: value.hubEdges === true,
  };
}

/**
 * Read the stored document, falling back per field.
 *
 * `legacy` is the GP-154 trio (`groundplan.diff.*`), used only when no
 * document has been written yet.
 */
export function parsePanelPrefs(
  stored: unknown,
  legacy: { enabled: boolean; mode: BaselineMode; changedOnly: boolean },
): PanelPrefs {
  if (!isRecord(stored) || stored.version !== 1) {
    // Either nothing was written, or it was written by a version whose shape
    // this one cannot claim to understand. Adopt the old diff keys and move on.
    return { ...DEFAULT_PANEL_PREFS, diff: { ...legacy } };
  }

  const lens = LENSES.find((candidate) => candidate === stored.lens);
  const diff = isRecord(stored.diff) ? stored.diff : {};
  const mode = MODES.find((candidate) => candidate === diff.mode);

  return {
    version: 1,
    lens: lens ?? DEFAULT_PANEL_PREFS.lens,
    diff: {
      enabled: diff.enabled === true,
      mode: mode ?? DEFAULT_PANEL_PREFS.diff.mode,
      changedOnly: diff.changedOnly === true,
    },
    filters: readFilters(stored.filters),
    followCursor: stored.followCursor !== false,
  };
}

/**
 * Does this preference change need the host to do anything?
 *
 * Only the diff does. A lens, a filter and follow-cursor are all folds of, or
 * decisions about, a snapshot the panel already holds — re-parsing the
 * workspace for one of them would be a round trip to redraw what is already on
 * screen, and on a large stack that is a visible stall for nothing.
 */
export function needsRefresh(before: PanelPrefs, after: PanelPrefs): boolean {
  return (
    before.diff.enabled !== after.diff.enabled ||
    before.diff.mode !== after.diff.mode ||
    before.diff.changedOnly !== after.diff.changedOnly
  );
}
