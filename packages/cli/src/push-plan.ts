import type { GitContext } from "./git-context.js";

/** A failure with a chosen process exit code. `2` = usage/config, `1` = runtime. */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export interface PushPlanConfig {
  /** Webhook URL (GROUNDPLAN_URL); the full per-repository ingestion endpoint. */
  url: string | undefined;
  /** Webhook secret (GROUNDPLAN_TOKEN). */
  token: string | undefined;
  /** Path to the plan.json. */
  file: string | undefined;
  /** Overrides for the auto-detected git context. */
  branch?: string;
  sha?: string;
  prNumber?: number;
  event?: "push" | "pull_request";
}

/** Everything the command touches the outside world through — injected in tests. */
export interface PushPlanDeps {
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

/** A body that looks like `terraform show -json` output. */
function isTerraformPlan(value: unknown): value is { resource_changes: unknown[] } {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Record<string, unknown>;
  return "format_version" in plan && Array.isArray(plan.resource_changes);
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
      return "the plan is too large (413) — Groundplan accepts up to 10 MB";
    default:
      return `Groundplan rejected the request (${status}): ${serverMessage}`;
  }
}

/**
 * Validate a plan.json locally and send it to the Groundplan webhook (GP-110).
 *
 * Everything that can be checked without the network is checked first — the file
 * exists, is JSON, and looks like a plan — so a mistake fails instantly with a
 * clear message instead of a server round-trip. Then the git context fills in
 * `ref` / `commit_sha` / the PR number (overridable by flags), and the body is
 * POSTed with retry on 5xx/network and fail-fast on 4xx.
 *
 * The body is sent as plain JSON, not gzip: the webhook contract (GP-5) parses
 * JSON and is deliberately unchanged, so compressing it here would break it.
 */
export async function pushPlan(
  config: PushPlanConfig,
  deps: PushPlanDeps,
): Promise<void> {
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
  if (!config.file) {
    throw new CliError("no plan file given — pass --file <plan.json>", 2);
  }

  // 1. Read + validate the plan locally, before touching the network.
  let raw: string;
  try {
    raw = deps.readFile(config.file);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw new CliError(`plan file not found: ${config.file}`);
    }
    throw new CliError(`could not read ${config.file}: ${errMessage(err)}`);
  }

  let plan: unknown;
  try {
    plan = JSON.parse(raw);
  } catch {
    throw new CliError(
      `${config.file} is not valid JSON — produce it with \`terraform show -json plan.out > plan.json\``,
    );
  }
  if (!isTerraformPlan(plan)) {
    throw new CliError(
      `${config.file} does not look like a Terraform plan (no format_version / resource_changes) — produce it with \`terraform show -json\``,
    );
  }

  // 2. Resolve the git context; flags win over detection.
  const ctx = deps.gitContext();
  const branch = config.branch ?? ctx.branch ?? undefined;
  if (!branch) {
    throw new CliError(
      "could not determine the branch — pass --branch (or set it via your CI's branch env var)",
    );
  }
  const sha = config.sha ?? ctx.sha ?? undefined;
  if (!sha) {
    throw new CliError("could not determine the commit sha — pass --sha");
  }
  const prNumber = config.prNumber ?? ctx.prNumber ?? null;
  const event = config.event ?? (prNumber !== null ? "pull_request" : "push");

  const body = JSON.stringify({
    ref: branch,
    commit_sha: sha,
    event,
    ...(prNumber !== null ? { pr_number: prNumber } : {}),
    payload: plan,
  });
  const changes = plan.resource_changes.length;

  // 3. Send, retrying transient failures with exponential backoff.
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
      response = await deps.fetch(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Groundplan-Token": config.token,
        },
        body,
      });
    } catch (err) {
      lastError = `network error: ${errMessage(err)}`;
      continue; // transient — retry
    }

    if (response.ok) {
      deps.log(
        `✓ sent ${changes} resource change(s) for ${branch} @ ${sha.slice(0, 7)} (${event})`,
      );
      return;
    }

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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
