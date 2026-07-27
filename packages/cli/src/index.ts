#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { parseArgs, stringFlag } from "./args.js";
import { detectGitContext } from "./git-context.js";
import { runGit } from "./git.js";
import { CliError, pushPlan } from "./push-plan.js";
import { pushDrift } from "./push-drift.js";
import { pushState } from "./push-state.js";
import type { PushStateDeps } from "./push-state.js";

const USAGE = `groundplan — send what your pipeline knows to Groundplan

Usage:
  groundplan push-plan  --file plan.json     a plan, for the pull-request diagram
  groundplan push-drift --file plan.json     a \`plan -refresh-only\`, for drift
  groundplan push-state --file state.json    a state, for the reality view

Options:
  --file <path>     the JSON to send (from \`terraform show -json\`)
  --url <url>       webhook URL              (env: GROUNDPLAN_URL)
  --token <token>   webhook secret           (env: GROUNDPLAN_TOKEN)
  --branch <name>   override the detected branch
  --sha <sha>       override the detected commit sha
  --pr <number>     override the detected pull request number (push-plan only)
  --dry-run         push-state only: write the payload locally, send nothing
  --out <path>      push-state only: where --dry-run writes
  --help            show this help

Branch, sha and PR number are auto-detected from the git checkout and common CI
environment variables; the flags above override them.

push-drift sends a refresh-only plan — what changed in the cloud without anybody
asking Terraform to. It is measured against a branch, never a pull request, and a
plan that proposes changes is refused: that one says what your code wants, not
what the cloud did. Produce it with:

  terraform plan -refresh-only -out=tfplan
  terraform show -json tfplan > plan.json

push-state parses your state **locally** and sends only the graph it derives —
the state file itself never leaves your machine, and the server refuses one. Use
--dry-run to read the exact payload before sending it:

  terraform state pull > terraform.tfstate
  groundplan push-state --file terraform.tfstate --dry-run
`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.help === true || command === undefined || command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  // One dependency bag for every command: `PushStateDeps` is `PushDeps` plus the
  // one write a dry run performs, and the other commands simply never call it.
  const deps: PushStateDeps = {
    readFile: (path: string) => readFileSync(path, "utf8"),
    writeFile: (path: string, contents: string) => writeFileSync(path, contents),
    gitContext: () => detectGitContext(process.env, runGit),
    fetch,
    sleep: (ms: number) => delay(ms),
    log: (message: string) => process.stderr.write(`${message}\n`),
  };
  const endpoint = {
    url: stringFlag(flags.url) ?? process.env.GROUNDPLAN_URL,
    token: stringFlag(flags.token) ?? process.env.GROUNDPLAN_TOKEN,
    file: stringFlag(flags.file),
    branch: stringFlag(flags.branch),
    sha: stringFlag(flags.sha),
  };

  if (command === "push-drift") {
    await pushDrift(endpoint, deps);
    return;
  }
  if (command === "push-state") {
    await pushState(
      {
        ...endpoint,
        dryRun: flags["dry-run"] === true,
        out: stringFlag(flags.out),
      },
      deps,
    );
    return;
  }
  if (command !== "push-plan") {
    throw new CliError(`unknown command: ${command}\n\n${USAGE}`, 2);
  }

  const prFlag = stringFlag(flags.pr);
  const prNumber = prFlag !== undefined ? Number.parseInt(prFlag, 10) : undefined;

  await pushPlan(
    {
      ...endpoint,
      prNumber:
        prNumber !== undefined && Number.isInteger(prNumber) ? prNumber : undefined,
    },
    deps,
  );
}

try {
  await main();
} catch (err: unknown) {
  const exitCode = err instanceof CliError ? err.exitCode : 1;
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`✗ ${message}\n`);
  process.exit(exitCode);
}
