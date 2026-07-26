/**
 * `groundplan push-drift` (GP-206): tell Groundplan what changed in the cloud
 * without anybody asking Terraform to.
 *
 * It sends a `terraform plan -refresh-only`, which your own pipeline produced
 * with your own credentials. That is the whole trick of reconciling code with
 * reality here: the refresh needs cloud access, so the party that already has it
 * does it, and we read the artefact — exactly as we read a plan.json instead of
 * running `terraform` ourselves.
 *
 * The one rule worth stating twice: a refresh-only plan **plans nothing**. If the
 * file proposes a create, an update or a delete, it came from a normal
 * `terraform plan` and describes what the code wants, not what the cloud did.
 * We refuse it here, locally, before the request — a pipeline that has
 * misconfigured this deserves to learn so in the step that did it.
 */
import { CliError, isTerraformPlan } from "./push-plan.js";
import {
  postJson,
  readJsonFile,
  requireEndpoint,
  type PushDeps,
} from "./transport.js";

export interface PushDriftConfig {
  /** Webhook URL (GROUNDPLAN_URL) — the repository's ingestion endpoint. */
  url: string | undefined;
  /** Webhook secret (GROUNDPLAN_TOKEN). */
  token: string | undefined;
  /** Path to the refresh-only plan JSON. */
  file: string | undefined;
  /** Overrides for the auto-detected branch / sha. */
  branch?: string;
  sha?: string;
}

/**
 * The drift endpoint, derived from the URL CI already has. One environment
 * variable stays one environment variable: a second secret to configure is a
 * second thing to configure wrongly.
 */
export function driftUrl(base: string): string {
  if (base.endsWith("/drift")) return base;
  return `${base.endsWith("/") ? base.slice(0, -1) : base}/drift`;
}

/** Actions that mean the code wants to change a remote object. */
const PLANNED_ACTIONS = new Set(["create", "update", "delete"]);

/**
 * The actions a plan proposes, sorted — empty for a refresh-only plan. Mirrors
 * the server's gate (`graph/drift.ts`) so the failure lands locally, in the step
 * that produced the file, instead of after a round trip.
 */
function plannedActions(resourceChanges: unknown[]): string[] {
  const planned = new Set<string>();
  for (const raw of resourceChanges) {
    const actions = (raw as { change?: { actions?: unknown } }).change?.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      if (typeof action === "string" && PLANNED_ACTIONS.has(action)) {
        planned.add(action);
      }
    }
  }
  return [...planned].sort((a, b) => a.localeCompare(b));
}

const PRODUCE =
  "produce it with `terraform plan -refresh-only -out=tfplan && terraform show -json tfplan`";

export async function pushDrift(
  config: PushDriftConfig,
  deps: PushDeps,
): Promise<void> {
  const { url, token } = requireEndpoint(config);
  if (!config.file) {
    throw new CliError("no plan file given — pass --file <plan.json>", 2);
  }

  // 1. Read + validate locally. Nothing here needs the network.
  const plan = readJsonFile(config.file, deps, { noun: "plan", hint: PRODUCE });
  if (!isTerraformPlan(plan)) {
    throw new CliError(
      `${config.file} does not look like a Terraform plan (no format_version / resource_changes) — ${PRODUCE}`,
    );
  }

  const proposed = plannedActions(plan.resource_changes);
  if (proposed.length > 0) {
    throw new CliError(
      `${config.file} proposes changes (${proposed.join(", ")}) — that is a normal plan, which says what your code wants, not what changed in the cloud. Drift is measured with \`terraform plan -refresh-only\`.`,
    );
  }

  // 2. Resolve the branch and sha; flags win over detection.
  //
  // No pull-request number, ever: drift is measured against the branch that is
  // deployed, and attaching it to a PR would anchor a fact about the estate to a
  // proposal about it. A cron job on a feature branch measures that branch — the
  // server decides what to line the measurement up with.
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

  const drifted = Array.isArray(plan.resource_drift)
    ? plan.resource_drift.length
    : 0;
  const body = JSON.stringify({ ref: branch, commit_sha: sha, payload: plan });

  await postJson(driftUrl(url), token, body, deps);
  deps.log(
    drifted === 0
      ? `✓ no drift — ${branch} @ ${sha.slice(0, 7)} matches the cloud`
      : `✓ sent ${drifted} drifted resource(s) for ${branch} @ ${sha.slice(0, 7)}`,
  );
}
