/**
 * `groundplan push-state` (GP-208): send a picture of what actually exists,
 * without sending the state file that describes it.
 *
 * The rule this command exists to keep: **the raw state never leaves your
 * machine.** It is parsed and sanitised here (`state-parser.ts`), and only the
 * derived graph is sent — nodes, edges, and a scalar attribute bag with every
 * sensitive value stripped. The server refuses a raw state outright if one is
 * ever posted at it, so the promise is checkable from both ends.
 *
 * Because you are being asked to trust that, the command earns it twice:
 *  - it **prints what it is about to send** — how many resources, how many
 *    attributes, how many were withheld — before it sends anything;
 *  - `--dry-run` writes exactly that payload to a file and sends nothing, so
 *    you can read every byte before deciding.
 */
import { CliError } from "./push-plan.js";
import { UnsupportedStateError, parseState } from "./state-parser.js";
import {
  postJson,
  readJsonFile,
  requireEndpoint,
  type PushDeps,
} from "./transport.js";

export interface PushStateConfig {
  /** Webhook URL (GROUNDPLAN_URL) — the repository's ingestion endpoint. */
  url: string | undefined;
  /** Webhook secret (GROUNDPLAN_TOKEN). */
  token: string | undefined;
  /** Path to the state file. */
  file: string | undefined;
  /** Overrides for the auto-detected branch / sha. */
  branch?: string;
  sha?: string;
  /** Derive and write the payload locally; send nothing. */
  dryRun?: boolean;
  /** Where `--dry-run` writes. Defaults to `groundplan-state.json`. */
  out?: string;
}

/** `--dry-run` needs to put the payload somewhere a human can read it. */
export interface PushStateDeps extends PushDeps {
  writeFile: (path: string, contents: string) => void;
}

/** Where `--dry-run` writes when nobody said. */
const DEFAULT_OUT = "groundplan-state.json";

/** The reality endpoint, derived from the URL CI already has. */
export function stateUrl(base: string): string {
  if (base.endsWith("/state")) return base;
  return `${base.endsWith("/") ? base.slice(0, -1) : base}/state`;
}

const PRODUCE = "produce it with `terraform state pull > terraform.tfstate`";

export async function pushState(
  config: PushStateConfig,
  deps: PushStateDeps,
): Promise<void> {
  if (!config.file) {
    throw new CliError("no state file given — pass --file <terraform.tfstate>", 2);
  }

  // 1. Read, parse and sanitise — all of it here, none of it anywhere else.
  const raw = readJsonFile(config.file, deps, { noun: "state", hint: PRODUCE });
  let parsed;
  try {
    parsed = parseState(raw);
  } catch (err) {
    if (err instanceof UnsupportedStateError) throw new CliError(err.message);
    throw err;
  }

  // 2. Say what is about to happen, before it happens.
  deps.log(
    `derived ${count(parsed.resources, "resource")} and ${count(parsed.graph.edges.length, "relationship")} from ${config.file}` +
      (parsed.terraformVersion ? ` (Terraform ${parsed.terraformVersion})` : ""),
  );
  deps.log(
    `sending ${count(parsed.attributes, "attribute")}; ${parsed.masked} withheld (sensitive, secret-named, or not a plain value)`,
  );
  deps.log("no sensitive value is included — the state itself is never sent");

  // 3. A dry run stops here, having written the exact payload to disk. It needs
  //    no credentials: nothing is going anywhere, and demanding a token to
  //    perform a local audit would be a strange way to ask for trust.
  if (config.dryRun) {
    const out = config.out ?? DEFAULT_OUT;
    deps.writeFile(out, `${JSON.stringify(parsed.graph, null, 2)}\n`);
    deps.log(`✓ dry run — wrote the exact payload to ${out}; nothing was sent`);
    return;
  }

  const { url, token } = requireEndpoint(config);

  // 4. Resolve the branch and sha. A reality snapshot describes the estate a
  //    branch is supposed to build, never a pull request's proposal about it.
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

  const body = JSON.stringify({
    ref: branch,
    commit_sha: sha,
    ...(parsed.terraformVersion
      ? { terraform_version: parsed.terraformVersion }
      : {}),
    payload: parsed.graph,
  });

  await postJson(stateUrl(url), token, body, deps);
  deps.log(
    `✓ sent ${count(parsed.resources, "resource")} for ${branch} @ ${sha.slice(0, 7)}`,
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
