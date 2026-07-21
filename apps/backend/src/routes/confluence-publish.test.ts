/**
 * GP-180: publish a docs snapshot as a Confluence page — create once, update
 * version n+1 in place, recreate transparently when the page was deleted over
 * there, attachment updated under one filename, failures categorized and
 * stored on the connection. The Confluence client is a stub: these tests are
 * about our flow, not Atlassian's API.
 */
import { test, before } from "node:test";
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
import type { Graph } from "../graph/graph.js";
import type {
  ConfluenceClient,
  ConfluenceErrorKind,
} from "../services/confluence.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import { regenerateDocsForSha } from "../services/repo-docs.js";
import { seedOrg } from "../test-support.js";

const env = loadEnv();
const exec = promisify(execFile);

before(async () => {
  await runMigrations(env.databaseUrl);
});

/**
 * An in-memory Confluence: pages live in a Map, so deleting one over there is
 * `pages.clear()`. `failWith` makes every page call fail with one kind.
 */
function stubConfluence() {
  const pages = new Map<string, { version: number; storage: string; title: string }>();
  const calls: string[] = [];
  const attachments: Array<{ pageId: string; filename: string; contentType: string; bytes: number }> = [];
  let nextId = 1;

  const stub: ConfluenceClient & {
    pages: typeof pages;
    calls: typeof calls;
    attachments: typeof attachments;
    failWith: ConfluenceErrorKind | null;
  } = {
    pages,
    calls,
    attachments,
    failWith: null,
    async verifySpace() {
      return { ok: true, spaceName: "Docs" };
    },
    async getPage(_target, pageId) {
      calls.push(`get:${pageId}`);
      if (stub.failWith) return { ok: false, error: stub.failWith };
      const page = pages.get(pageId);
      if (!page) return { ok: false, error: "page_not_found" };
      return { ok: true, page: { id: pageId, version: page.version, url: `https://wiki.test/pages/${pageId}` } };
    },
    async createPage(_target, input) {
      if (stub.failWith) {
        calls.push("create:failed");
        return { ok: false, error: stub.failWith };
      }
      const id = `page-${nextId++}`;
      pages.set(id, { version: 1, storage: input.storage, title: input.title });
      calls.push(`create:${id}`);
      return { ok: true, page: { id, version: 1, url: `https://wiki.test/pages/${id}` } };
    },
    async updatePage(_target, input) {
      calls.push(`update:${input.pageId}:v${input.version}`);
      if (stub.failWith) return { ok: false, error: stub.failWith };
      const page = pages.get(input.pageId);
      if (!page) return { ok: false, error: "page_not_found" };
      page.version = input.version;
      page.storage = input.storage;
      return {
        ok: true,
        page: { id: input.pageId, version: input.version, url: `https://wiki.test/pages/${input.pageId}` },
      };
    },
    async uploadAttachment(_target, input) {
      calls.push(`attach:${input.pageId}:${input.filename}`);
      if (stub.failWith) return { ok: false, error: stub.failWith };
      attachments.push({
        pageId: input.pageId,
        filename: input.filename,
        contentType: input.contentType,
        bytes: input.data.length,
      });
      return { ok: true };
    },
  };
  return stub;
}

const GRAPH: Graph = {
  version: 1,
  nodes: [
    {
      id: "aws_s3_bucket.a",
      name: "a",
      type: "aws_s3_bucket",
      provider: "aws",
      module_path: [],
      change: null,
    },
  ],
  edges: [],
};

let counter = 0;
async function seedRepoWithConnection(
  app: FastifyInstance,
  orgId: string,
  opts: { url?: string; connection?: boolean } = {},
) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "P", slug: `cpub-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id as string;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: opts.url ?? "https://github.com/acme/infra" },
  });
  const repoId = r.json().id as string;
  if (opts.connection !== false) {
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
      payload: {
        baseUrl: "https://acme.atlassian.net/wiki",
        spaceKey: "DOCS",
        authType: "dc_pat",
        credential: "pat",
      },
    });
    assert.equal(put.statusCode, 201);
  }
  return { projectId, repoId };
}

test("first publish creates page + attachment; second updates in place, no duplicates", async () => {
  const stub = stubConfluence();
  const app = await buildApp(
    { ...env, publicBaseUrl: "https://app.test" },
    { confluence: stub },
  );
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId } = await seedRepoWithConnection(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "abcdef1234567890",
      graph: GRAPH,
    });

    const url = `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence/publish`;
    const first = await app.inject({ method: "POST", url });
    assert.equal(first.statusCode, 200);
    const firstBody = first.json();
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.pageUrl, "https://wiki.test/pages/page-1");

    // The page holds the rendered summary, the diagram macro and the link back.
    const page = stub.pages.get("page-1");
    assert.ok(page);
    assert.equal(page.title, "acme/infra");
    assert.ok(page.storage.includes("<h1>Infrastructure documentation</h1>"));
    assert.ok(page.storage.includes('ri:filename="diagram.png"'));
    assert.ok(
      page.storage.includes(
        `https://app.test/projects/${projectId}/repos/${repoId}/docs`,
      ),
    );
    // The PNG went up under the page, as image/png, with real bytes in it.
    assert.equal(stub.attachments.length, 1);
    assert.equal(stub.attachments[0]?.pageId, "page-1");
    assert.equal(stub.attachments[0]?.filename, "diagram.png");
    assert.equal(stub.attachments[0]?.contentType, "image/png");
    assert.ok((stub.attachments[0]?.bytes ?? 0) > 0);

    // Publish state is on the connection, for the UI.
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
    });
    assert.equal(got.json().pageUrl, "https://wiki.test/pages/page-1");
    assert.ok(got.json().lastPublishedAt);
    assert.equal(got.json().lastPublishError, null);

    // Second publish: same page, version n+1, same attachment filename.
    const second = await app.inject({ method: "POST", url });
    assert.equal(second.json().ok, true);
    assert.equal(stub.pages.size, 1);
    assert.equal(stub.pages.get("page-1")?.version, 2);
    assert.equal(stub.calls.filter((c) => c.startsWith("create:")).length, 1);
    assert.ok(stub.calls.includes("update:page-1:v2"));
    assert.equal(stub.attachments.length, 2);
    assert.equal(stub.attachments[1]?.filename, "diagram.png");
  } finally {
    await app.close();
  }
});

test("a page deleted on the Confluence side is recreated transparently", async () => {
  const stub = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const { repoId } = await seedRepoWithConnection(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "sha-1",
      graph: GRAPH,
    });

    const url = `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence/publish`;
    await app.inject({ method: "POST", url });
    assert.equal(stub.pages.size, 1);

    // Somebody deletes the page over there.
    stub.pages.clear();

    const republished = await app.inject({ method: "POST", url });
    assert.equal(republished.json().ok, true);
    assert.equal(republished.json().pageUrl, "https://wiki.test/pages/page-2");
    // The stored id moved to the new page — the next publish updates it.
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
    });
    assert.equal(got.json().pageUrl, "https://wiki.test/pages/page-2");
  } finally {
    await app.close();
  }
});

test("failures are categorized, stored on the connection, and cleared on success", async () => {
  const stub = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const { repoId } = await seedRepoWithConnection(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "sha-1",
      graph: GRAPH,
    });

    const url = `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence/publish`;
    stub.failWith = "auth_failed";
    const failed = await app.inject({ method: "POST", url });
    assert.equal(failed.statusCode, 200);
    assert.deepEqual(failed.json(), { ok: false, error: "auth_failed" });

    const got = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
    });
    assert.equal(got.json().lastPublishError, "auth_failed");
    assert.equal(got.json().lastPublishedAt, null);

    stub.failWith = null;
    const ok = await app.inject({ method: "POST", url });
    assert.equal(ok.json().ok, true);
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
    });
    assert.equal(after.json().lastPublishError, null);
    assert.ok(after.json().lastPublishedAt);
  } finally {
    await app.close();
  }
});

test("no connection or nothing to publish is a 404, and no client call is made", async () => {
  const stub = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const bare = await seedRepoWithConnection(app, orgId, { connection: false });
    const noConnection = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${bare.repoId}/confluence/publish`,
    });
    assert.equal(noConnection.statusCode, 404);

    const { repoId } = await seedRepoWithConnection(app, orgId);
    const noSnapshot = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence/publish`,
    });
    assert.equal(noSnapshot.statusCode, 404);
    assert.equal(stub.pages.size, 0);
    assert.equal(stub.calls.filter((c) => !c.startsWith("get")).length, 0);
  } finally {
    await app.close();
  }
});

// --- Auto-publish on merge (the GP-23 hook) ---

async function makeFixtureRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-confluence-"));
  const git = async (...args: string[]) => {
    await exec("git", args, { cwd: dir });
  };
  await git("init", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "Fixture");
  await fs.writeFile(
    path.join(dir, "main.tf"),
    'resource "aws_s3_bucket" "a" {\n  bucket = "a"\n}\n',
  );
  await git("add", ".");
  await git("commit", "-m", "first");
  return dir;
}

test("docs regeneration on merge auto-publishes — if and only if a connection exists", async () => {
  const stub = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const fixture = await makeFixtureRepo();
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: fixture });
    const sha = stdout.trim();

    // Without a connection: docs regenerate, Confluence never hears about it.
    const silent = await seedRepoWithConnection(app, orgId, {
      url: `file://${fixture}`,
      connection: false,
    });
    const [silentRepo] = await app.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, silent.repoId));
    await regenerateDocsForSha(app, silentRepo as RepositoryRow, sha);
    assert.equal(stub.pages.size, 0);

    // With one: the fresh docs snapshot publishes in the same pass.
    const wired = await seedRepoWithConnection(app, orgId, {
      url: `file://${fixture}`,
    });
    const [wiredRepo] = await app.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, wired.repoId));
    await regenerateDocsForSha(app, wiredRepo as RepositoryRow, sha);
    assert.equal(stub.pages.size, 1);

    const got = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${wired.repoId}/confluence`,
    });
    assert.ok(got.json().lastPublishedAt);
  } finally {
    await app.close();
  }
});
