import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import mime from "mime-types";

const execFileAsync = promisify(execFile);

/** Abort a clone that hangs (e.g. auth prompt, unreachable host). */
const CLONE_TIMEOUT_MS = 60_000;

export type Provider = "github" | "gitlab";

export type RepoSource = {
  url: string;
  provider: Provider;
  ref: string;
  /** Optional token for private repos. Never logged, never returned. */
  accessToken?: string | null;
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
): string {
  if (!accessToken) return rawUrl;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (u.protocol !== "https:") return rawUrl;
  if (provider === "gitlab") {
    u.username = "oauth2";
    u.password = accessToken;
  } else {
    u.username = accessToken;
    u.password = "";
  }
  return u.toString();
}

/** Remove the token from any text before it reaches logs or error messages. */
function redact(text: string, token?: string | null): string {
  return token ? text.split(token).join("***") : text;
}

function toErrorText(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === "string" && e.stderr.trim()) return e.stderr.trim();
    if (typeof e.message === "string") return e.message;
  }
  return String(err);
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
    if (!stat || !stat.isFile()) return null;
    const content = await fs.readFile(abs);
    const contentType =
      mime.contentType(path.basename(abs)) || "application/octet-stream";
    return { content, contentType };
  });
}
