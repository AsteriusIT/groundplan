/**
 * `pnpm seed:examples` — attach `examples/terraform/*` to the local instance.
 *
 * Thin entry: build the app the way the server does, run the seeding service,
 * print what happened, exit. Everything interesting is in `services/dev-seed.ts`.
 *
 * Refuses to run in production. It creates organizations' projects and rewrites
 * a directory of git repositories; that is a development convenience, and a
 * production database has no business meeting it.
 */
import "dotenv/config";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { seedExamples, type SeedOptions } from "../services/dev-seed.js";
import { runMigrations } from "./migrate.js";

function parseArgs(argv: string[]): SeedOptions & { help: boolean } {
  const opts: SeedOptions & { help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--org") opts.orgSlug = next();
    else if (arg === "--only") opts.only = next().split(",").filter(Boolean);
    else if (arg === "--examples") opts.examplesDir = next();
    else if (arg === "--repos") opts.reposDir = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const USAGE = `
Attach the Terraform examples to this local instance.

  pnpm seed:examples [options]

  --org <slug>       organization to attach them to (default: "default")
  --only <a,b>       seed only these example folders
  --force            rebuild the git repositories (new commits, fresh docs)
  --examples <dir>   where the example folders are
  --repos <dir>      where the bare git repositories are written
  -h, --help         this message

Idempotent: re-running reuses what is already there. Log in to the app once
before seeding, so there is a user to make a member of the organization.
`.trim();

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.info(USAGE);
  process.exit(0);
}

const env = loadEnv();
if (env.nodeEnv === "production") {
  console.error("✖ seed:examples is a development tool and refuses to run in production");
  process.exit(1);
}

await runMigrations(env.databaseUrl);
const app = await buildApp(env);

try {
  const result = await seedExamples(app, args);

  const failed = result.repositories.filter((r) => r.error);
  const ok = result.repositories.filter((r) => !r.error);

  console.info(`\norganization: ${result.orgSlug} (${result.members} member(s))`);
  if (result.membersAdded > 0) {
    console.info(`  added ${result.membersAdded} existing user(s) as members`);
  }
  if (result.members === 0) {
    console.info(
      "  no users yet — log in to the app once and they will join this org automatically",
    );
  }

  console.info("");
  for (const repo of ok) {
    const at = repo.terraformPath ? ` @ ${repo.terraformPath}` : "";
    const graph = `${repo.nodes ?? "?"} nodes, ${repo.edges ?? "?"} edges`;
    const policy = repo.policyStatus ?? "not evaluated";
    const warnings = repo.warnings > 0 ? `, ${repo.warnings} warning(s)` : "";
    const state = repo.documented ? "generated" : "up to date";
    console.info(
      `  ✔ ${repo.example}${at} — ${graph}, policy ${policy}${warnings} (${state})`,
    );
  }
  for (const repo of failed) {
    const at = repo.terraformPath ? ` @ ${repo.terraformPath}` : "";
    console.error(`  ✖ ${repo.example}${at} — ${repo.error}`);
  }

  console.info(
    `\n${ok.length} repositor${ok.length === 1 ? "y" : "ies"} attached to ${result.orgSlug}.` +
      (failed.length > 0 ? ` ${failed.length} failed.` : ""),
  );
  await app.close();
  process.exit(failed.length > 0 ? 1 : 0);
} catch (err) {
  console.error("✖ seeding failed:", err);
  await app.close();
  process.exit(1);
}
