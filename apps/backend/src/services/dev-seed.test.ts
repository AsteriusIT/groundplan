import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import {
  graphSnapshots,
  organizations,
  projects,
  repositories,
} from "../db/schema.js";
import { seedOrg } from "../test-support.js";
import {
  EXAMPLE_CATALOG,
  materializeExampleRepo,
  seedExamples,
  type SeedResult,
} from "./dev-seed.js";

const env = loadEnv();

let app: FastifyInstance;
let workDir: string;
let examplesDir: string;
let reposDir: string;

/**
 * A miniature `examples/terraform`: two folders whose names match real catalogue
 * entries (so the seeder picks them up), one with two entrypoints. The real
 * examples are deliberately not used — the seeder's contract is "whatever is in
 * the folder", and asserting on their contents here would make every edit to an
 * example break this file.
 */
before(async () => {
  await runMigrations(env.databaseUrl);
  app = await buildApp(env);
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-seed-test-"));
  examplesDir = path.join(workDir, "examples");
  reposDir = path.join(workDir, "repos");

  const single = path.join(examplesDir, "azure-iam");
  await fs.mkdir(single, { recursive: true });
  await fs.writeFile(
    path.join(single, "main.tf"),
    `resource "azurerm_resource_group" "main" {\n  name     = "rg-seed"\n  location = "westeurope"\n}\n`,
  );

  const monorepo = path.join(examplesDir, "multi-module-monorepo");
  for (const stack of ["platform", "sandbox"]) {
    const dir = path.join(monorepo, "stacks", stack);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "main.tf"),
      `resource "azurerm_resource_group" "${stack}" {\n  name     = "rg-${stack}"\n  location = "westeurope"\n}\n`,
    );
  }
});

after(async () => {
  await app.close();
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * One org and one slug prefix per test. Project slugs are unique across the
 * whole instance and the suite shares the developer's database, so a fixed
 * prefix would collide with a real `pnpm seed:examples` run.
 */
async function scope(): Promise<{ orgId: string; orgSlug: string; prefix: string }> {
  const orgId = await seedOrg(app);
  const [org] = await app.db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return {
    orgId,
    orgSlug: org!.slug,
    prefix: `test-example-${Date.now()}-${randomBytes(4).toString("hex")}-`,
  };
}

function seed(
  orgSlug: string,
  slugPrefix: string,
  only = ["azure-iam", "multi-module-monorepo"],
): Promise<SeedResult> {
  return seedExamples(app, { examplesDir, reposDir, orgSlug, slugPrefix, only });
}

test("materializes an example as a bare repo with a deterministic sha", async () => {
  const source = path.join(examplesDir, "azure-iam");
  const bare = path.join(workDir, "standalone.git");

  const first = await materializeExampleRepo(source, bare);
  assert.equal(first.created, true);
  assert.equal(first.url, `file://${bare}`);
  assert.match(first.commitSha, /^[0-9a-f]{40}$/);

  // Same content, rebuilt from scratch: the fixed identity and date make the
  // commit sha identical, which is what "already seeded" recognition relies on.
  const rebuilt = await materializeExampleRepo(source, bare, { force: true });
  assert.equal(rebuilt.created, true);
  assert.equal(rebuilt.commitSha, first.commitSha);

  // And without --force it is read back rather than rewritten.
  const reused = await materializeExampleRepo(source, bare);
  assert.equal(reused.created, false);
  assert.equal(reused.commitSha, first.commitSha);
});

test("attaches every entrypoint and documents it from a real clone", async () => {
  const { orgId, orgSlug, prefix } = await scope();
  const result = await seed(orgSlug, prefix);

  assert.equal(result.organizationId, orgId);
  assert.equal(result.repositories.length, 3, "one root + two entrypoints");
  for (const repo of result.repositories) {
    assert.equal(repo.error, undefined);
    assert.ok(repo.url.startsWith("file://"));
    assert.equal(repo.attached, true);
    assert.equal(repo.documented, true);
    assert.ok((repo.nodes ?? 0) > 0, "the snapshot came from a real parse");
    assert.equal(repo.policyStatus, "passing");
  }

  // The monorepo is attached twice, at two terraform paths, from one clone —
  // and each entrypoint sees only its own stack.
  const monorepo = result.repositories.filter(
    (r) => r.example === "multi-module-monorepo",
  );
  assert.deepEqual(monorepo.map((r) => r.terraformPath).sort(), [
    "stacks/platform",
    "stacks/sandbox",
  ]);
  assert.equal(new Set(monorepo.map((r) => r.url)).size, 1, "one clone, two roots");

  for (const entry of monorepo) {
    const [snapshot] = await app.db
      .select({ graph: graphSnapshots.graph })
      .from(graphSnapshots)
      .where(eq(graphSnapshots.repositoryId, entry.repositoryId));
    const nodes = (snapshot!.graph as { nodes: { id: string }[] }).nodes;
    const stack = entry.terraformPath.split("/")[1];
    assert.deepEqual(
      nodes.map((n) => n.id),
      [`azurerm_resource_group.${stack}`],
    );
  }
});

test("is idempotent: a second run adds no project, repository or snapshot", async () => {
  const { orgId, orgSlug, prefix } = await scope();
  const first = await seed(orgSlug, prefix);

  const countRows = async () => {
    const projectRows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.organizationId, orgId));
    const repoRows = await Promise.all(
      projectRows.map((p) =>
        app.db
          .select({ id: repositories.id })
          .from(repositories)
          .where(eq(repositories.projectId, p.id)),
      ),
    );
    const ids = repoRows.flat().map((r) => r.id);
    const snapshots = await Promise.all(
      ids.map((id) =>
        app.db
          .select({ id: graphSnapshots.id })
          .from(graphSnapshots)
          .where(
            and(
              eq(graphSnapshots.repositoryId, id),
              eq(graphSnapshots.source, "hcl"),
            ),
          ),
      ),
    );
    return {
      projects: projectRows.length,
      repositories: ids.length,
      snapshots: snapshots.flat().length,
    };
  };

  const counts = await countRows();
  const second = await seed(orgSlug, prefix);

  assert.deepEqual(await countRows(), counts, "nothing was created twice");
  for (const repo of second.repositories) {
    assert.equal(repo.error, undefined);
    assert.equal(repo.attached, false, "the repository row was reused");
    assert.equal(repo.documented, false, "the snapshot for this sha was reused");
  }
  assert.deepEqual(
    second.repositories.map((r) => r.repositoryId).sort(),
    first.repositories.map((r) => r.repositoryId).sort(),
  );
});

test("a missing example folder fails alone", async () => {
  const { orgSlug, prefix } = await scope();
  const result = await seed(orgSlug, prefix, ["azure-iam", "aws-three-tier"]);

  const aws = result.repositories.find((r) => r.example === "aws-three-tier");
  assert.match(aws?.error ?? "", /no such example folder/);
  const iam = result.repositories.find((r) => r.example === "azure-iam");
  assert.equal(iam?.error, undefined, "the other example still seeded");
});

test("an unknown organization is refused by slug", async () => {
  await assert.rejects(
    () => seed("no-such-org-slug", "test-example-unused-"),
    /no organization with slug/,
  );
});

test("the catalogue points at folders that exist, with Terraform at each entrypoint", async () => {
  const real = path.resolve(import.meta.dirname, "../../../../examples/terraform");
  for (const example of EXAMPLE_CATALOG) {
    const dir = path.join(real, example.dir);
    const isDir = await fs
      .stat(dir)
      .then((s) => s.isDirectory())
      .catch(() => false);
    assert.ok(isDir, `${example.dir} is in the catalogue but not on disk`);

    for (const entrypoint of example.entrypoints) {
      const files = await fs.readdir(path.join(dir, entrypoint));
      assert.ok(
        files.some((f) => f.endsWith(".tf")),
        `${example.dir}/${entrypoint} holds no .tf file`,
      );
    }
  }
});
