import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import mime from "mime-types";

import { cloneUsername } from "../integrations/registry.js";
import type { CredentialMode } from "../integrations/types.js";
import type { Provider } from "./providers.js";

const execFileAsync = promisify(execFile);

/** Abort a clone that hangs (e.g. auth prompt, unreachable host). */
const CLONE_TIMEOUT_MS = 60_000;

export type { Provider };

export type RepoSource = {
  url: string;
  provider: Provider;
  ref: string;
  /** Optional token for private repos. Never logged, never returned. */
  accessToken?: string | null;
  /**
   * Which credential strategy produced `accessToken` (GP-192). It only ever
   * decides the *username* half of the clone URL, which some providers vary by
   * mode; defaults to `pat`, what every repository used before this existed.
   */
  credentialMode?: CredentialMode;
};

export type FileContent = { content: Buffer; contentType: string };

/** Thrown when a requested file path escapes the repository root. */
export class PathTraversalError extends Error {
  constructor() {
    super("path traversal is not allowed");
    this.name = "PathTraversalError";
  }
}

/** Inject credentials into an https clone URL. No-op without a token. */
export function buildAuthenticatedUrl(
  rawUrl: string,
  provider: Provider,
  accessToken?: string | null,
  credentialMode: CredentialMode = "pat",
): string {
  if (!accessToken) return rawUrl;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (u.protocol !== "https:") return rawUrl;
  // One uniform credential form per provider (GP-51): the token is the password,
  // the username comes from the provider's adapter (GP-192).
  u.username = cloneUsername(provider, credentialMode);
  u.password = accessToken;
  return u.toString();
}

/** Remove the token from any text before it reaches logs or error messages. */
function redact(text: string, token?: string | null): string {
  return token ? text.split(token).join("***") : text;
}

/**
 * What actually went wrong, in words.
 *
 * `stderr` alone is a trap: when `execFile` kills git on timeout, stderr holds
 * whatever git had printed *so far* — for a clone that is `Cloning into
 * '/tmp/…'...`, a progress line that reads like success. A production failure
 * reported as "git clone failed: Cloning into '/tmp/gp-clone-tcghrH'..." tells
 * nobody anything. So how the process ended is appended to what it said.
 */
function toErrorText(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);

  const e = err as {
    stderr?: unknown;
    message?: unknown;
    killed?: unknown;
    signal?: unknown;
    code?: unknown;
  };

  const parts: string[] = [];
  if (typeof e.stderr === "string" && e.stderr.trim()) {
    parts.push(e.stderr.trim());
  } else if (typeof e.message === "string") {
    parts.push(e.message);
  }

  if (e.killed === true) {
    parts.push(
      `(git was killed after ${CLONE_TIMEOUT_MS / 1000}s — the host never answered)`,
    );
  } else if (typeof e.signal === "string" && e.signal) {
    parts.push(`(terminated by ${e.signal})`);
  } else if (typeof e.code === "string" && e.code) {
    // ENOENT, ENOTFOUND, ECONNREFUSED… — the shape a spawn failure takes.
    parts.push(`(${e.code})`);
  } else if (typeof e.code === "number" && e.code !== 0) {
    parts.push(`(git exited ${e.code})`);
  }

  return parts.length > 0 ? parts.join(" ") : String(err);
}

function ensureValidRef(ref: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith("-") || ref.includes("..")) {
    throw new Error(`invalid git ref: ${ref}`);
  }
}

/** Normalize a request path and reject anything that escapes the root. */
function ensureSafeRelativePath(filePath: string): string {
  const norm = path.posix.normalize(filePath.replaceAll("\\", "/"));
  if (norm.startsWith("/") || norm === ".." || norm.startsWith("../")) {
    throw new PathTraversalError();
  }
  return norm;
}

async function cloneRepo(source: RepoSource, destDir: string): Promise<void> {
  ensureValidRef(source.ref);
  const cloneUrl = buildAuthenticatedUrl(
    source.url,
    source.provider,
    source.accessToken,
    source.credentialMode,
  );
  try {
    await execFileAsync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        source.ref,
        cloneUrl,
        destDir,
      ],
      { timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
  } catch (err) {
    throw new Error(
      `git clone failed: ${redact(toErrorText(err), source.accessToken)}`,
    );
  }
}

/** Clone into a throwaway temp dir, run `fn`, and always clean up. */
async function withClone<T>(
  source: RepoSource,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-clone-"));
  try {
    await cloneRepo(source, dir);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function walkFiles(root: string, dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(root, abs)));
    } else if (entry.isFile()) {
      out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  }
  return out;
}

/** List every file path (relative, posix-style) in the repo at `ref`. */
export async function listFiles(source: RepoSource): Promise<string[]> {
  return withClone(source, async (dir) => {
    const files = await walkFiles(dir, dir);
    return files.sort((a, b) => a.localeCompare(b));
  });
}

export type RepoTextFile = { path: string; content: string };

/**
 * Clone the repo once at `ref`, read the UTF-8 contents of every file matching
 * `matches`, and capture the resulting HEAD sha. Used by the docs flow (GP-15) so
 * a whole-repo parse needs a single clone (unlike per-request `getFile`).
 *
 * When `checkoutSha` is given (auto-docs on merge, GP-23), the exact commit is
 * fetched and checked out so the snapshot matches the pushed sha — not just the
 * branch tip. If that commit can't be fetched, the cloned tip is used instead.
 * The temp clone is always cleaned up.
 */
export async function readRepoTextFiles(
  source: RepoSource,
  matches: (path: string) => boolean,
  checkoutSha?: string,
): Promise<{ files: RepoTextFile[]; headSha: string }> {
  return withClone(source, async (dir) => {
    if (checkoutSha) {
      ensureValidRef(checkoutSha);
      try {
        await execFileAsync(
          "git",
          ["-C", dir, "fetch", "--depth", "1", "origin", checkoutSha],
          { timeout: CLONE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        );
        await execFileAsync("git", ["-C", dir, "checkout", "--force", checkoutSha], {
          timeout: CLONE_TIMEOUT_MS,
        });
      } catch {
        // Commit unreachable/shallow — fall back to the cloned branch tip.
      }
    }
    const paths = (await walkFiles(dir, dir)).filter(matches);
    const files: RepoTextFile[] = [];
    for (const rel of paths) {
      files.push({ path: rel, content: await fs.readFile(path.join(dir, rel), "utf8") });
    }
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"], {
      timeout: CLONE_TIMEOUT_MS,
    });
    return { files, headSha: stdout.trim() };
  });
}

/** Read one file at `ref`. Returns null if it is missing or not a file. */
export async function getFile(
  source: RepoSource & { filePath: string },
): Promise<FileContent | null> {
  const safe = ensureSafeRelativePath(source.filePath);
  const { filePath: _filePath, ...repo } = source;
  return withClone(repo, async (dir) => {
    const abs = path.resolve(dir, safe);
    // Defense in depth: confirm the resolved path is still inside the clone.
    const rel = path.relative(dir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PathTraversalError();
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) return null;
    const content = await fs.readFile(abs);
    const contentType =
      mime.contentType(path.basename(abs)) || "application/octet-stream";
    return { content, contentType };
  });
}

/** The remote data the ref poller needs: no ref to check out, just credentials. */
export type RemoteSource = Pick<
  RepoSource,
  "url" | "provider" | "accessToken" | "credentialMode"
>;

/**
 * List every `refs/heads/*` on the remote and its sha (GP-107), via
 * `git ls-remote --heads` — no clone. Keys are short branch names (the
 * `refs/heads/` prefix stripped), so they compare directly against a
 * repository's `defaultBranch`. Tags and other namespaces are ignored: the
 * `--heads` flag asks git for branches only.
 *
 * Throws on failure (unreachable host, revoked PAT). The caller treats that as
 * "no information", never as "every branch was deleted".
 */
export async function listRemoteHeads(
  source: RemoteSource,
): Promise<Map<string, string>> {
  const url = buildAuthenticatedUrl(
    source.url,
    source.provider,
    source.accessToken,
    source.credentialMode,
  );
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["ls-remote", "--heads", url], {
      timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }));
  } catch (err) {
    // The raw exec error carries the authenticated URL — token and all — in its
    // `cmd`/`message`/`stack`. Redact it at the source so no caller can leak the
    // PAT into a log or the stored `pollError`, however it handles the error.
    throw new Error(
      `git ls-remote failed: ${redact(toErrorText(err), source.accessToken)}`,
    );
  }
  const prefix = "refs/heads/";
  const heads = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref?.startsWith(prefix)) continue;
    heads.set(ref.slice(prefix.length), sha);
  }
  return heads;
}

export type VerifyErrorKind = "auth_failed" | "not_found" | "network";

export type VerifyResult =
  | { ok: true; defaultBranchFound: boolean }
  | {
      ok: false;
      error: VerifyErrorKind;
      /**
       * The redacted git failure, for the server log only — never part of an
       * API response, and never carrying the token. The classification is what
       * a user can act on; this is what an operator needs when "the repository
       * could not be reached" is true but useless.
       */
      detail?: string;
    };

/**
 * The verifier the test environment uses by default (wired in `buildApp`).
 *
 * Attaching a repository now proves it is reachable *before* persisting it
 * (GP-229), which would otherwise make every fixture repository in the suite
 * shell out to `git ls-remote` against a URL that does not exist. It answers
 * "reachable" because that is the uninteresting case; a test about a failed
 * check injects its own verifier, and the real classification of a git failure
 * is covered against real `git` in `repo-files.test.ts`.
 */
export const offlineVerifyConnection = async (): Promise<VerifyResult> => ({
  ok: true,
  defaultBranchFound: true,
});

/** Classify a `git` failure into a caller-friendly reason. */
export function classifyGitError(text: string): VerifyErrorKind {
  const t = text.toLowerCase();
  if (
    /authentication failed|invalid username or password|could not read username|terminal prompts disabled|http 401|http 403|\b401\b|\b403\b/.test(
      t,
    )
  ) {
    return "auth_failed";
  }
  if (
    /repository not found|not found|does not exist|not appear to be a git|http 404|\b404\b/.test(
      t,
    )
  ) {
    return "not_found";
  }
  return "network";
}

/**
 * Check that a repository is reachable with the given credentials via
 * `git ls-remote`. The ref is compared against the listed heads (never passed
 * to git), so it cannot be interpreted as a flag.
 */
export async function verifyConnection(source: RepoSource): Promise<VerifyResult> {
  const url = buildAuthenticatedUrl(
    source.url,
    source.provider,
    source.accessToken,
    source.credentialMode,
  );
  try {
    const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", url], {
      timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const target = `refs/heads/${source.ref}`;
    const defaultBranchFound = stdout
      .split("\n")
      .some((line) => line.split("\t")[1] === target);
    return { ok: true, defaultBranchFound };
  } catch (err) {
    const detail = redact(toErrorText(err), source.accessToken);
    return { ok: false, error: classifyGitError(detail), detail };
  }
}
