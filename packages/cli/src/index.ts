#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { parseArgs, stringFlag } from "./args.js";
import { detectGitContext } from "./git-context.js";
import { runGit } from "./git.js";
import { CliError, pushPlan } from "./push-plan.js";

const USAGE = `groundplan — send a Terraform plan.json to Groundplan from CI

Usage:
  groundplan push-plan --file plan.json

Options:
  --file <path>     the plan.json to send (from \`terraform show -json\`)
  --url <url>       webhook URL              (env: GROUNDPLAN_URL)
  --token <token>   webhook secret           (env: GROUNDPLAN_TOKEN)
  --branch <name>   override the detected branch
  --sha <sha>       override the detected commit sha
  --pr <number>     override the detected pull request number
  --help            show this help

Branch, sha and PR number are auto-detected from the git checkout and common CI
environment variables; the flags above override them.
`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.help === true || command === undefined || command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (command !== "push-plan") {
    throw new CliError(`unknown command: ${command}\n\n${USAGE}`, 2);
  }

  const prFlag = stringFlag(flags.pr);
  const prNumber = prFlag !== undefined ? Number.parseInt(prFlag, 10) : undefined;

  await pushPlan(
    {
      url: stringFlag(flags.url) ?? process.env.GROUNDPLAN_URL,
      token: stringFlag(flags.token) ?? process.env.GROUNDPLAN_TOKEN,
      file: stringFlag(flags.file),
      branch: stringFlag(flags.branch),
      sha: stringFlag(flags.sha),
      prNumber:
        prNumber !== undefined && Number.isInteger(prNumber) ? prNumber : undefined,
    },
    {
      readFile: (path) => readFileSync(path, "utf8"),
      gitContext: () => detectGitContext(process.env, runGit),
      fetch,
      sleep: (ms) => delay(ms),
      log: (message) => process.stderr.write(`${message}\n`),
    },
  );
}

main().catch((err: unknown) => {
  const exitCode = err instanceof CliError ? err.exitCode : 1;
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`✗ ${message}\n`);
  process.exit(exitCode);
});
