/**
 * Every user-facing string in the panel, in one place.
 *
 * The extension has no i18n mechanism, and inventing one for a preview panel
 * would be a lot of machinery for no reader. What this does buy today is that
 * a sentence said in two places is written once — the static-diff explanation
 * appears in the diff popover, behind the status bar's ⓘ and in the first-run
 * notice, and three copies of it would eventually say three different things.
 */
import { branchRefOf, shortRef, type BaselineMode } from "../src/messages";

export const strings = {
  lens: {
    label: "View",
    infra: "Global",
    network: "Network",
    iam: "IAM",
  },
  diff: {
    label: "Diff",
    /**
     * The short name of a baseline, for the button and the popover rows. The
     * status bar prints the resolved ref; here the reader wants the choice they
     * made. The default branch is *detected* and passed in — this used to be a
     * table with `main` written into it, which was a guess on any repository
     * whose trunk is called something else.
     */
    baseLabel: (mode: BaselineMode, defaultBranch: string | null): string => {
      const ref = branchRefOf(mode);
      if (ref !== null) return shortRef(ref);
      if (mode === "head") return "HEAD";
      return defaultBranch ?? "default branch";
    },
    against: (base: string) => `vs ${base}`,
    toggleHint: "Colour the diagram as changes against a git baseline",
    options: "Diff options",
    clean: "No changes",
    unavailable: "No baseline",
    /** The counters as a sentence: "+3 ~1 −2" read aloud is not one. */
    spokenCounts: (counts: {
      created: number;
      updated: number;
      deleted: number;
    }) =>
      [
        counts.created > 0 ? `${counts.created} created` : null,
        counts.updated > 0 ? `${counts.updated} updated` : null,
        counts.deleted > 0 ? `${counts.deleted} deleted` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(", "),
    baseLegend: "Compare against",
    baseHead: "HEAD — what you have not committed yet",
    /** Named when the repository told us; never guessed when it did not. */
    baseDefault: (name: string | null) =>
      `${name ?? "Default branch"} — everything on this branch`,
    pickBranch: "Branch…",
    pickBranchHint: "Compare against another branch",
    changedOnly: "Changed only",
    changedOnlyHint: "Show changed nodes and one hop of context",
    aboutTitle: "About this diff",
    /**
     * The honest framing, said once. A static diff is not a plan and must
     * never be allowed to read like one.
     */
    about:
      "This compares your working tree against the baseline — it is not a " +
      "Terraform plan. It reads no state and does not expand count or for_each.",
  },
  search: {
    label: "Search resources",
    placeholder: "Search resources…",
    close: "Close search",
  },
  filters: {
    label: "Filters",
    active: (count: number) => `${count} filter${count === 1 ? "" : "s"}`,
    clearAll: "Clear all filters",
    remove: (label: string) => `Stop hiding ${label}`,
  },
  legend: {
    label: "Legend",
    open: "What the diagram's colours and lines mean",
    empty: "Nothing on this diagram needs explaining.",
  },
  zoom: {
    in: "Zoom in",
    out: "Zoom out",
    fit: "Fit the diagram",
    fitChanges: "Fit the changes",
  },
  overflow: {
    label: "More",
    followCursor: "Follow cursor",
    followCursorHint:
      "Select the resource the cursor is in. The camera only moves when that resource is off screen.",
  },
  shortcuts: {
    title: "Keyboard",
    diff: "Toggle diff mode",
    lens: "Global / Network / IAM",
    fit: "Fit the diagram",
    search: "Search resources",
    escape: "Close, then collapse, then deselect",
  },
  status: {
    label: "Preview status",
    rendering: "Rendering…",
    synced: "Synced",
    error: "Error",
    about: "About this diff",
    diffUnavailable: (reason: string | null) =>
      `Diff unavailable — ${reason ?? "no baseline"}. Showing the live view.`,
    outOfSync: "Out of sync — showing the last good parse",
    multiRoot: (folder: string) =>
      `Previewing “${folder}” — the first of several workspace folders.`,
  },
} as const;
