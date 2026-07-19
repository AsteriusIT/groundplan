/**
 * The git baseline provider (GP-152) — the "before" side of diff mode. Given
 * a baseline mode (HEAD, or the merge-base with main), return the committed
 * `.tf` file set at that ref plus its parsed snapshot, so the differ always
 * has a before-graph without shelling out on the typing path.
 *
 * No `vscode` import: the extension wires editors and watchers around it, and
 * node:test exercises it against real throwaway repositories.
 *
 * Caching is two-layered and deliberately asymmetric:
 *  - mode → resolved sha is cheap but *moves* (commit, checkout, fetch) —
 *    `invalidate()` clears it and nothing else;
 *  - sha → files + parsed snapshot is expensive but *immutable* — a sha's
 *    content never changes, so it is only ever evicted for size, never for
 *    staleness. Keystrokes re-parse the "after" side only; a warm `get()`
 *    performs zero git invocations (verifiable via the `log` hook).
 */
import { execFile } from "node:child_process";
import { existsSync, statSync, watch } from "node:fs";
import { dirname, join } from "node:path";

import { parse, type Graph, type HclFile } from "@groundplan/graph-parser";

import type { BaselineMode } from "./messages";
import { toPosixRelative } from "./paths";

export type { BaselineMode } from "./messages";

/** Run git with `args` in `cwd`; resolves raw stdout, rejects on any failure. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/** Big enough for any sane `.tf`; `git show` output must never be truncated. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
  });

export type Baseline = {
  /** The resolved commit the baseline was read from. */
  sha: string;
  /** What the diff is against, for the caption: "HEAD" / "merge-base main". */
  ref: string;
  /** Folder-relative `.tf` files at the sha — the differ's "before" input. */
  files: HclFile[];
  /** Parsed once per sha (parse once, diff many). */
  snapshot: Graph;
};

export type BaselineResult =
  | { ok: true; baseline: Baseline }
  | { ok: false; reason: string };

/** Mirror of the live view's TF_EXCLUDE_GLOB — vendored dirs never diff. */
const EXCLUDED_SEGMENTS = new Set([".terraform", "node_modules"]);

function isDiagramTf(path: string): boolean {
  if (!path.endsWith(".tf")) return false;
  return !path.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

/** How many distinct shas keep their parsed baseline around. */
const SHA_CACHE_LIMIT = 4;

export class BaselineProvider {
  /** mode → resolved ref; cleared by invalidate() (commit/checkout/fetch). */
  private readonly refByMode = new Map<BaselineMode, { sha: string; ref: string }>();
  /** sha → immutable content; evicted for size only. */
  private readonly bySha = new Map<string, { files: HclFile[]; snapshot: Graph }>();
  private toplevel: string | null = null;

  constructor(
    private readonly folder: string,
    private readonly git: GitRunner = runGit,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Drop the mode → sha resolution; the next get() asks git again. */
  invalidate(): void {
    this.refByMode.clear();
  }

  async get(mode: BaselineMode): Promise<BaselineResult> {
    let resolved = this.refByMode.get(mode);
    if (!resolved) {
      try {
        resolved = await this.resolve(mode);
      } catch (error) {
        return { ok: false, reason: reasonOf(error) };
      }
      this.refByMode.set(mode, resolved);
    }

    let content = this.bySha.get(resolved.sha);
    if (!content) {
      try {
        content = await this.read(resolved.sha);
      } catch (error) {
        return { ok: false, reason: reasonOf(error) };
      }
      this.bySha.set(resolved.sha, content);
      // Evict the oldest entries; a sha's content never goes stale, only big.
      for (const key of this.bySha.keys()) {
        if (this.bySha.size <= SHA_CACHE_LIMIT) break;
        this.bySha.delete(key);
      }
    }

    return { ok: true, baseline: { ...resolved, ...content } };
  }

  private run(args: string[], cwd: string): Promise<string> {
    this.log(`git ${args.join(" ")}`);
    return this.git(args, cwd);
  }

  private async root(): Promise<string> {
    this.toplevel ??= (
      await this.run(["rev-parse", "--show-toplevel"], this.folder)
    ).trim();
    return this.toplevel;
  }

  private async resolve(
    mode: BaselineMode,
  ): Promise<{ sha: string; ref: string }> {
    const cwd = await this.root();
    if (mode === "head") {
      const sha = (await this.run(["rev-parse", "HEAD"], cwd)).trim();
      return { sha, ref: "HEAD" };
    }
    for (const branch of ["origin/main", "main"]) {
      try {
        const sha = (
          await this.run(["merge-base", "HEAD", branch], cwd)
        ).trim();
        return { sha, ref: `merge-base ${branch}` };
      } catch {
        // Try the next candidate; a repo without origin/main is normal.
      }
    }
    throw new Error("no origin/main or main branch to compare against");
  }

  /** The committed `.tf` set at `sha`, folder-relative, parsed. */
  private async read(
    sha: string,
  ): Promise<{ files: HclFile[]; snapshot: Graph }> {
    const cwd = await this.root();
    // Folder-relative prefix inside the repo; "" when the folder *is* the
    // root (toPosixRelative echoes paths that don't sit under the root —
    // symlinked temp dirs and the like — which also means "no prefix").
    const prefix = toPosixRelative(cwd, this.folder);
    const inFolder = /^([A-Za-z]:)?\//.test(prefix) ? "" : prefix;

    const listed = await this.run(
      ["ls-tree", "-r", sha, "--name-only", "-z", ...(inFolder ? ["--", inFolder] : [])],
      cwd,
    );
    const paths = listed.split("\0").filter(Boolean).filter(isDiagramTf);

    const files = await Promise.all(
      paths.map(async (path) => ({
        path: inFolder ? path.slice(inFolder.length + 1) : path,
        content: await this.run(["show", `${sha}:${path}`], cwd),
      })),
    );
    files.sort((a, b) => (a.path < b.path ? -1 : 1));

    // Baseline files are committed code: even if a commit somehow fails to
    // parse cleanly, the partial snapshot is still the honest "before".
    const { snapshot } = parse(files);
    return { files, snapshot };
  }
}

/**
 * The directory holding `.git`, walking up from `start` — where the git
 * watcher must sit when the workspace folder is a subdirectory of the repo.
 * Null outside any repository (or when `.git` is a worktree file).
 */
export function findGitRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    try {
      if (statSync(join(dir, ".git")).isDirectory()) return dir;
    } catch {
      // No .git here — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type GitWatcher = { dispose: () => void };

/** Only ref movement matters: HEAD, branch refs, pack/fetch bookkeeping. */
const REF_EVENT_RE = /^(HEAD|ORIG_HEAD|packed-refs|refs\/)/;

/**
 * Watch `.git` for baseline-moving events — commit, checkout, branch switch,
 * fetch — debounced into one `onChange`. VS Code's own file watcher excludes
 * `.git` by default, so this is plain `fs.watch`. Editing files in the
 * worktree never touches these paths, which is exactly the point: typing must
 * not re-run git (GP-152). Returns null when the folder has no `.git` to
 * watch (non-repo, or a worktree's `.git` file — out of scope).
 */
export function watchGitChanges(
  folder: string,
  onChange: () => void,
  debounceMs = 300,
): GitWatcher | null {
  const gitDir = join(folder, ".git");
  try {
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return null;
  } catch {
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(gitDir, { recursive: true }, (_event, filename) => {
      const name = filename?.replaceAll("\\", "/") ?? "";
      // Lock files churn on every git command; ignore them and the object DB.
      if (!REF_EVENT_RE.test(name) || name.endsWith(".lock")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, debounceMs);
    });
  } catch {
    return null;
  }

  return {
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      watcher.close();
    },
  };
}

/** A git failure, worn as a one-line human reason. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not a git repository/i.test(message)) return "not a git repository";
  if (/unknown revision|ambiguous argument 'HEAD'|bad revision/i.test(message)) {
    return "no commits yet";
  }
  return message.split("\n")[0] ?? "git failed";
}
