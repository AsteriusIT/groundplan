/**
 * Work out the branch, commit sha, and pull-request number of the checkout the
 * CLI is running in (GP-110), from CI environment variables first and a local
 * `git` call as the fallback. Kept pure — env in, context out — so every rule is
 * testable without a real checkout or a real CI runner.
 *
 * The CI variables come first because a CI checkout is often detached HEAD (a
 * merge ref), where `git rev-parse --abbrev-ref HEAD` says `HEAD` and knows
 * nothing — the forge, meanwhile, put the real branch in an env var.
 */
export type Env = Record<string, string | undefined>;

/** Runs a `git` subcommand, returning trimmed stdout or null on any failure. */
export type GitRunner = (args: string[]) => string | null;

export interface GitContext {
  branch: string | null;
  sha: string | null;
  prNumber: number | null;
}

function firstEnv(env: Env, keys: string[]): string | null {
  for (const key of keys) {
    const value = env[key];
    if (value && value.trim() !== "") return value.trim();
  }
  return null;
}

/**
 * The head branch. `GITHUB_HEAD_REF` (a PR's source branch) and the GitLab MR
 * source branch come first, because on a PR the plain "ref name" is a merge ref,
 * not the branch. Only then the ambient branch name, and finally local git.
 */
export function detectBranch(env: Env, runGit: GitRunner): string | null {
  const fromEnv = firstEnv(env, [
    "GITHUB_HEAD_REF", // GitHub Actions, pull_request events
    "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME", // GitLab CI, merge requests
    "GITHUB_REF_NAME", // GitHub Actions, push events
    "CI_COMMIT_REF_NAME", // GitLab CI, push pipelines
    "BUILD_SOURCEBRANCHNAME", // Azure DevOps
  ]);
  if (fromEnv) return fromEnv;

  const fromGit = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  // "HEAD" means detached — no branch to name, so the caller must be told.
  return fromGit && fromGit !== "HEAD" ? fromGit : null;
}

export function detectSha(env: Env, runGit: GitRunner): string | null {
  const fromEnv = firstEnv(env, [
    "GITHUB_SHA",
    "CI_COMMIT_SHA",
    "BUILD_SOURCEVERSION",
  ]);
  return fromEnv ?? runGit(["rev-parse", "HEAD"]);
}

/**
 * The pull-request number, if this run is on one. GitHub Actions hides it in
 * `GITHUB_REF` (`refs/pull/<n>/merge`); GitLab and Azure expose it directly. A
 * run with no PR returns null, and the caller sends a `push` instead.
 */
export function detectPrNumber(env: Env): number | null {
  const ghRef = env.GITHUB_REF;
  if (ghRef) {
    const match = /^refs\/pull\/(\d+)\//.exec(ghRef);
    if (match) return Number(match[1]);
  }
  const direct = firstEnv(env, [
    "CI_MERGE_REQUEST_IID", // GitLab
    "SYSTEM_PULLREQUEST_PULLREQUESTID", // Azure DevOps
  ]);
  if (direct) {
    const n = Number.parseInt(direct, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

export function detectGitContext(env: Env, runGit: GitRunner): GitContext {
  return {
    branch: detectBranch(env, runGit),
    sha: detectSha(env, runGit),
    prNumber: detectPrNumber(env),
  };
}
