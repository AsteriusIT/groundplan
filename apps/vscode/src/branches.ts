/**
 * The branch list behind diff mode's "Branch…" picker.
 *
 * Its own module rather than a helper inside `extension.ts`, for the reason
 * `git-baseline.ts` is one: it imports no `vscode`, so it can be exercised
 * against real repositories. What is left in the extension host — showing a
 * QuickPick and storing the answer — has nothing left to decide.
 *
 * The list is never sent to the webview. The panel asks the host to pick, the
 * host asks git; a branch list that crossed the wire could only arrive stale.
 */
import { isBaselineMode, shortRef } from "./messages";
import type { GitRunner } from "./git-baseline";

/** A branch offered as a diff baseline. */
export type BranchRef = {
  /** Fully qualified — what git is handed, and what the mode stores. */
  ref: string;
  /** The reader's name for it: `master`, `origin/release/2.4`. */
  name: string;
  /** How long ago it last moved, as the picker's second line. */
  when: string;
};

/** `%09` is a literal tab; a ref cannot contain one, so it frames the record. */
const FORMAT = "--format=%(refname)%09%(committerdate:relative)";

/**
 * Every branch, most recently committed first — the order that makes the
 * branch somebody is working on the first thing they see.
 *
 * Rejects rather than returning `[]` when git fails: a repository that cannot
 * be read and one with nothing to offer are different answers, and only one of
 * them is worth interrupting the reader about.
 */
export async function listBranches(
  git: GitRunner,
  cwd: string,
): Promise<BranchRef[]> {
  const out = await git(
    ["for-each-ref", "--sort=-committerdate", FORMAT, "refs/heads", "refs/remotes"],
    cwd,
  );
  return parseBranchRefs(out);
}

/** One `<refname>\t<relative date>` record per line. */
export function parseBranchRefs(output: string): BranchRef[] {
  const branches: BranchRef[] = [];
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const ref = line.slice(0, tab);
    // `refs/remotes/<remote>/HEAD` is a symbolic pointer at the remote's
    // default branch, not a branch of its own — offering it would put the
    // same commit in the list twice under a name nobody chose.
    if (/^refs\/remotes\/[^/]+\/HEAD$/.test(ref)) continue;
    // The same gate the stored preference passes through: a ref this
    // extension would refuse to resolve must not be offered as a choice.
    if (!isBaselineMode(`branch:${ref}`)) continue;
    branches.push({ ref, name: shortRef(ref), when: line.slice(tab + 1) });
  }
  return branches;
}
