/** A failure with a chosen process exit code. `2` = usage/config, `1` = runtime. */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

import {
  postJson,
  readJsonFile,
  requireEndpoint,
  type PushDeps,
} from "./transport.js";

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

/** Kept as the historical name; the shape lives in `transport` now (GP-206). */
export type PushPlanDeps = PushDeps;

/** A body that looks like `terraform show -json` output. */
export function isTerraformPlan(
  value: unknown,
): value is { resource_changes: unknown[]; resource_drift?: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Record<string, unknown>;
  return "format_version" in plan && Array.isArray(plan.resource_changes);
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
  const { url, token } = requireEndpoint(config);
  if (!config.file) {
    throw new CliError("no plan file given — pass --file <plan.json>", 2);
  }

  // 1. Read + validate the plan locally, before touching the network.
  const plan = readJsonFile(config.file, deps, {
    noun: "plan",
    hint: "produce it with `terraform show -json plan.out > plan.json`",
  });
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
  await postJson(url, token, body, deps);
  deps.log(
    `✓ sent ${changes} resource change(s) for ${branch} @ ${sha.slice(0, 7)} (${event})`,
  );
}
