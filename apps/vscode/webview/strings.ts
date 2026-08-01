/**
 * Every user-facing string in the panel, in one place.
 *
 * The extension has no i18n mechanism, and inventing one for a preview panel
 * would be a lot of machinery for no reader. What this does buy today is that
 * a sentence said in two places is written once — the static-diff explanation
 * appears in the diff popover, behind the status bar's ⓘ and in the first-run
 * notice, and three copies of it would eventually say three different things.
 */
export const strings = {
  lens: {
    label: "View",
    infra: "Global",
    network: "Network",
    iam: "IAM",
  },
  diff: {
    label: "Diff",
    /** The short name of a baseline, for the button. The status bar prints the
     * resolved ref; here the reader wants the choice they made. */
    base: { head: "HEAD", "merge-base": "main" } as const,
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
    baseMergeBase: "main — everything on this branch",
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
} as const;
