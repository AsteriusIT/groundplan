#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { parseArgs, stringFlag } from "./args.js";
import { detectGitContext } from "./git-context.js";
import { runGit } from "./git.js";
import { CliError, pushPlan } from "./push-plan.js";
import { pushDrift } from "./push-drift.js";
import type { PushDeps } from "./transport.js";

const USAGE = `groundplan — send what your pipeline knows to Groundplan

Usage:
  groundplan push-plan  --file plan.json     a plan, for the pull-request diagram
  groundplan push-drift --file plan.json     a \`plan -refresh-only\`, for drift

Options:
  --file <path>     the JSON to send (from \`terraform show -json\`)
  --url <url>       webhook URL              (env: GROUNDPLAN_URL)
  --token <token>   webhook secret           (env: GROUNDPLAN_TOKEN)
  --branch <name>   override the detected branch
  --sha <sha>       override the detected commit sha
  --pr <number>     override the detected pull request number (push-plan only)
  --help            show this help

Branch, sha and PR number are auto-detected from the git checkout and common CI
environment variables; the flags above override them.

push-drift sends a refresh-only plan — what changed in the cloud without anybody
asking Terraform to. It is measured against a branch, never a pull request, and a
plan that proposes changes is refused: that one says what your code wants, not
what the cloud did. Produce it with:

  terraform plan -refresh-only -out=tfplan
  terraform show -json tfplan > plan.json
`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.help === true || command === undefined || command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  const deps: PushDeps = {
    readFile: (path) => readFileSync(path, "utf8"),
    gitContext: () => detectGitContext(process.env, runGit),
    fetch,
    sleep: (ms) => delay(ms),
    log: (message) => process.stderr.write(`${message}\n`),
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
