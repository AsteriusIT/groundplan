import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { repositories, type RepositoryRow } from "../db/schema.js";
import { seedOrg } from "../test-support.js";
import { generateDocsSnapshot } from "./repo-docs.js";

const env = loadEnv();
const exec = promisify(execFile);

let fixtureUrl: string;
let fixtureDir: string;

/**
 * A repository whose Terraform is NOT at the root: the stack lives in `infra/`,
 * sources a module from *above* it (`../modules/shared`), and a second, unrelated
 * stack sits in `other/`. This is the layout the terraform path exists for.
 */
before(async () => {
  await runMigrations(env.databaseUrl);
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-tfpath-"));
  const git = (args: string[]) => exec("git", args, { cwd: fixtureDir });

  await fs.mkdir(path.join(fixtureDir, "infra"), { recursive: true });
  await fs.mkdir(path.join(fixtureDir, "modules", "shared"), { recursive: true });
  await fs.mkdir(path.join(fixtureDir, "other"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureDir, "infra", "main.tf"),
    `resource "aws_s3_bucket" "app" {\n  bucket = "app"\n}\n\nmodule "shared" {\n  source = "../modules/shared"\n}\n`,
  );
  await fs.writeFile(
    path.join(fixtureDir, "modules", "shared", "main.tf"),
    `resource "aws_kms_key" "k" {\n  description = "shared"\n}\n`,
  );
  await fs.writeFile(
    path.join(fixtureDir, "other", "main.tf"),
    `resource "aws_s3_bucket" "other" {\n  bucket = "other"\n}\n`,
  );

  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["add", "."]);
  await git(["commit", "-m", "terraform in a subdirectory"]);
  fixtureUrl = `file://${fixtureDir}`;
});

after(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

let counter = 0;
async function createRepo(
  app: FastifyInstance,
  terraformPath: string,
): Promise<RepositoryRow> {
  counter += 1;
  const orgId = await seedOrg(app);
  const project = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "TF", slug: `tfpath-docs-${Date.now()}-${counter}` },
  });
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${project.json().id}/repositories`,
    payload: {
      provider: "github",
      url: fixtureUrl,
      defaultBranch: "main",
      terraformPath,
    },
  });
  const [repo] = await app.db
    .select()
    .from(repositories)
    .where(eq(repositories.id, created.json().id));
  return repo!;
}

test("docs generation parses the repository's terraform path, not the root", async () => {
  const app = await buildApp(env);
  try {
    const repo = await createRepo(app, "infra");
    const snapshot = await generateDocsSnapshot(app, repo);
    const ids = snapshot.graph.nodes.map((n) => n.id);

    assert.ok(ids.includes("aws_s3_bucket.app"), "the stack under infra/ is parsed");
    // A module sourced from above the terraform root still resolves, exactly as
    // `terraform -chdir=infra` would resolve it.
    assert.ok(ids.includes("module.shared.aws_kms_key.k"));
    // An unrelated stack the entrypoint never reaches stays out of the graph.
    assert.ok(!ids.includes("aws_s3_bucket.other"));
  } finally {
    await app.close();
  }
});

test("a repository left at the root sees no terraform in this layout, and says so", async () => {
  const app = await buildApp(env);
  try {
    const repo = await createRepo(app, "");
    const snapshot = await generateDocsSnapshot(app, repo);
    assert.equal(snapshot.graph.nodes.length, 0);
  } finally {
    await app.close();
  }
});

test("a terraform path pointing nowhere warns instead of storing an empty graph", async () => {
  const app = await buildApp(env);
  try {
    const repo = await createRepo(app, "does-not-exist");
    const snapshot = await generateDocsSnapshot(app, repo);

    assert.equal(snapshot.graph.nodes.length, 0);
    // `warnings` rides in the snapshot's extra stats (a jsonb bag), so it is
    // untyped at the edge — narrow it here rather than trusting the shape.
    const raw = (snapshot.stats as Record<string, unknown>).warnings;
    const warnings = Array.isArray(raw) ? (raw as string[]) : [];
    assert.ok(
      warnings.some((w) => w.includes("does-not-exist")),
      `expected a warning naming the directory, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    await app.close();
  }
});
