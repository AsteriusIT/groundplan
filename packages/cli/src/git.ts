import { execFileSync } from "node:child_process";

import type { GitRunner } from "./git-context.js";

/**
 * The real `git` runner: synchronous, and null on any failure (git absent, not a
 * repository, detached in a way the command dislikes). Every git fact the CLI
 * uses has an env-var source and a flag override, so a null here is a fallback
 * that ran dry, never a fatal error on its own.
 */
export const runGit: GitRunner = (args) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};
