/**
 * The one way this CLI talks to Groundplan: POST some JSON, retry a blip, fail
 * fast and readably on a mistake.
 *
 * Extracted from `push-plan` (GP-110) when a second and third thing became
 * pushable — a drift measurement (GP-206) and a reality snapshot (GP-208).
 * All three want identical CI ergonomics, and three copies of a retry loop is
 * three chances for one of them to fail quietly in somebody's pipeline.
 */
import type { GitContext } from "./git-context.js";
import { CliError } from "./push-plan.js";

/** Everything the commands touch the outside world through — injected in tests. */
export interface PushDeps {
  /** Read a file as UTF-8; throws with `.code === "ENOENT"` when missing. */
  readFile: (path: string) => string;
  gitContext: () => GitContext;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Progress/success lines (stderr in the real CLI, captured in tests). */
  log: (message: string) => void;
}

/** How many times a 5xx / network failure is retried before giving up. */
const MAX_RETRIES = 3;

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readServerMessage(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return response.statusText;
  }
  try {
    const data: unknown = JSON.parse(text);
    if (data && typeof data === "object" && "message" in data) {
      const message = (data as { message: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Non-JSON body — the raw text is the best we have.
  }
  return text.trim() || response.statusText;
}

/** Map a non-retryable 4xx to an actionable, human-readable message. */
function clientErrorMessage(status: number, serverMessage: string): string {
  switch (status) {
    case 401:
    case 403:
      return `authentication failed (${status}) — check GROUNDPLAN_TOKEN matches this repository's webhook secret`;
    case 404:
      return "repository not found (404) — check GROUNDPLAN_URL points at your repository's webhook endpoint";
    case 413:
      return "the payload is too large (413) — Groundplan accepts up to 10 MB";
    // 422 is the server explaining exactly what is wrong with what we sent (a
    // plan that proposes changes, a raw state file). Its own words are better
    // than anything we could substitute, so they are passed straight through.
    default:
      return `Groundplan rejected the request (${status}): ${serverMessage}`;
  }
}

/**
 * Read a UTF-8 JSON file, turning the two failures worth naming into CLI errors.
 * `noun` is what the file is ("plan", "state") so the message names the thing the
 * user was asked for rather than "file".
 */
export function readJsonFile(
  path: string,
  deps: Pick<PushDeps, "readFile">,
  { noun, hint }: { noun: string; hint: string },
): unknown {
  let raw: string;
  try {
    raw = deps.readFile(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw new CliError(`${noun} file not found: ${path}`);
    }
    throw new CliError(`could not read ${path}: ${errMessage(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`${path} is not valid JSON — ${hint}`);
  }
}

/**
 * POST a body, retrying transient failures with exponential backoff and failing
 * fast on a 4xx. Resolves on the first 2xx; throws `CliError` otherwise, so the
 * process exits non-zero and the CI step goes red where somebody can see it.
 */
export async function postJson(
  url: string,
  token: string,
  body: string,
  deps: PushDeps,
): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = 500 * 2 ** (attempt - 1);
      deps.log(
        `retrying in ${backoffMs}ms (attempt ${attempt + 1} of ${MAX_RETRIES + 1})…`,
      );
      await deps.sleep(backoffMs);
    }

    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Groundplan-Token": token,
        },
        body,
      });
    } catch (err) {
      lastError = `network error: ${errMessage(err)}`;
      continue; // transient — retry
    }

    if (response.ok) return;

    const serverMessage = await readServerMessage(response);
    if (response.status >= 500) {
      lastError = `server error ${response.status}: ${serverMessage}`;
      continue; // transient — retry
    }
    // 4xx is our mistake, not a blip: fail fast with an actionable message.
    throw new CliError(clientErrorMessage(response.status, serverMessage));
  }

  throw new CliError(
    `giving up after ${MAX_RETRIES + 1} attempts — ${lastError}`,
  );
}

/** The two things every command needs before it can send anything. */
export function requireEndpoint(config: {
  url: string | undefined;
  token: string | undefined;
}): { url: string; token: string } {
  if (!config.url) {
    throw new CliError(
      "GROUNDPLAN_URL is not set — pass --url or set the env var to your repository's webhook URL",
      2,
    );
  }
  if (!config.token) {
    throw new CliError(
      "GROUNDPLAN_TOKEN is not set — pass --token or set the env var to your repository's webhook secret",
      2,
    );
  }
  return { url: config.url, token: config.token };
}
