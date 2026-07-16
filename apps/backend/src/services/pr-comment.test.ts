import { test, before } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv, type AppEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { repositories, type GraphSnapshotRow } from "../db/schema.js";
import type { Graph } from "../graph/graph.js";
import { seedOrg } from "../test-support.js";
import { insertGraphSnapshot } from "./graph-snapshots.js";
import { buildCommentBody, COMMENT_MARKER, postPrComment } from "./pr-comment.js";
import { parseGitHubRepo, type GitHubClient, type GitHubComment } from "./github.js";
import { GitLabApiError, type GitLabClient, type GitLabNote } from "./gitlab.js";
import {
  AzureDevOpsApiError,
  type AdoThread,
  type AzureDevOpsClient,
} from "./azure-devops.js";

// --- Pure helpers -----------------------------------------------------------

test("parseGitHubRepo extracts owner/repo from https and ssh URLs", () => {
  assert.deepEqual(parseGitHubRepo("https://github.com/acme/infra.git"), {
    owner: "acme",
    repo: "infra",
  });
  assert.deepEqual(parseGitHubRepo("https://github.com/acme/infra"), {
    owner: "acme",
    repo: "infra",
  });
  assert.equal(parseGitHubRepo("https://gitlab.com/acme/infra"), null);
});

test("buildCommentBody leads with the marker and carries the summary", () => {
  const body = buildCommentBody({
    repoLabel: "acme/infra",
    ref: "refs/heads/feat",
    commitSha: "deadbeefcafe",
    summaryMd: "**+1 created** (1 resource)",
    imageUrl: null,
    viewUrl: null,
  });
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.ok(body.includes("acme/infra"));
  assert.ok(body.includes("deadbeef"));
  assert.ok(body.includes("**+1 created** (1 resource)"));
  assert.ok(!body.includes("![")); // no image without a URL
});

test("buildCommentBody embeds the image + view link when URLs are given", () => {
  const body = buildCommentBody({
    repoLabel: "acme/infra",
    ref: "main",
    commitSha: "abcd1234",
    summaryMd: "No changes.",
    imageUrl: "https://gp.example.com/api/v1/public/tok/export.png?scope=changes",
    viewUrl: "https://gp.example.com/share/tok",
  });
  assert.ok(body.includes("![Infrastructure change diagram](https://gp.example.com/api/v1/public/tok/export.png?scope=changes)"));
  assert.ok(body.includes("[View interactive diagram →](https://gp.example.com/share/tok)"));
});

// --- Integration with a fake GitHub client ----------------------------------

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

function fakeGitHub() {
  const comments = new Map<number, GitHubComment[]>(); // keyed by issue number
  const calls = { list: 0, create: 0, update: 0 };
  let nextId = 1000;
  const client: GitHubClient = {
    async listIssueComments(_o, _r, issue) {
      calls.list += 1;
      return [...(comments.get(issue) ?? [])];
    },
    async createIssueComment(_o, _r, issue, body) {
      calls.create += 1;
      const comment = { id: nextId++, body };
      comments.set(issue, [...(comments.get(issue) ?? []), comment]);
      return comment;
    },
    async updateIssueComment(_o, _r, id, body) {
      calls.update += 1;
      for (const list of comments.values()) {
        const found = list.find((c) => c.id === id);
        if (found) found.body = body;
      }
      return { id, body };
    },
  };
  return { client, calls, comments };
}

function fakeGitLab() {
  const notes = new Map<number, GitLabNote[]>(); // keyed by MR iid
  const calls = { list: 0, create: 0, update: 0 };
  let nextId = 5000;
  const client: GitLabClient = {
    async listMergeRequestNotes(_base, _path, iid) {
      calls.list += 1;
      return [...(notes.get(iid) ?? [])];
    },
    async createMergeRequestNote(_base, _path, iid, body) {
      calls.create += 1;
      const note = { id: nextId++, body };
      notes.set(iid, [...(notes.get(iid) ?? []), note]);
      return note;
    },
    async updateMergeRequestNote(_base, _path, _iid, id, body) {
      calls.update += 1;
      for (const list of notes.values()) {
        const found = list.find((n) => n.id === id);
        if (found) found.body = body;
      }
      return { id, body };
    },
  };
  return { client, calls, notes };
}

function fakeAzureDevOps() {
  const threads = new Map<number, AdoThread[]>(); // keyed by PR id
  const calls = { list: 0, create: 0, update: 0 };
  let nextThreadId = 900;
  let nextCommentId = 8000;
  const client: AzureDevOpsClient = {
    async listThreads(_base, _project, _repo, prId) {
      calls.list += 1;
      return [...(threads.get(prId) ?? [])];
    },
    async createThread(_base, _project, _repo, prId, content) {
      calls.create += 1;
      const thread = {
        id: nextThreadId++,
        comments: [{ id: nextCommentId++, content }],
      };
      threads.set(prId, [...(threads.get(prId) ?? []), thread]);
      return thread;
    },
    async updateComment(_base, _project, _repo, _prId, threadId, commentId, content) {
      calls.update += 1;
      for (const list of threads.values()) {
        const thread = list.find((t) => t.id === threadId);
        const comment = thread?.comments.find((c) => c.id === commentId);
        if (comment) comment.content = content;
      }
      return { id: commentId, content };
    },
  };
  return { client, calls, threads };
}

let counter = 0;
async function setupRepo(
  app: Awaited<ReturnType<typeof buildApp>>,
  opts: {
    enabled: boolean;
    withPat: boolean;
    provider?: string;
    url?: string;
  },
) {
  counter += 1;
  const orgId = await seedOrg(app);
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "C", slug: `cmt-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: {
      provider: opts.provider ?? "github",
      url: opts.url ?? "https://github.com/acme/infra",
    },
  });
  const repoId = r.json().id;
  // Set the flag + PAT directly (avoids the network re-verify path).
  await app.db
    .update(repositories)
    .set({
      prCommentsEnabled: opts.enabled,
      accessToken: opts.withPat ? app.encryptor.encrypt("ghp_test_token") : null,
    })
    .where(eq(repositories.id, repoId));
  return { orgId, projectId, repoId };
}

const graph = (change: "create" | "noop"): Graph => ({
  version: 2,
  nodes: [
    { id: "azurerm_subnet.a", name: "a", type: "azurerm_subnet", provider: "azurerm", module_path: [], change },
  ],
  edges: [],
});

async function insertPlan(
  app: Awaited<ReturnType<typeof buildApp>>,
  repoId: string,
  sha: string,
): Promise<GraphSnapshotRow> {
  return insertGraphSnapshot(app.db, {
    repositoryId: repoId,
    source: "plan",
    ref: "refs/heads/feat",
    commitSha: sha,
    prNumber: 42,
    graph: graph("create"),
  });
}

test("creates one comment, then updates it in place on the next push", async () => {
  const gh = fakeGitHub();
  const app = await buildApp(env, { github: gh.client });
  try {
    const { orgId, projectId, repoId } = await setupRepo(app, { enabled: true, withPat: true });

    await postPrComment(app, await insertPlan(app, repoId, "aaaaaaaa1111"));
    assert.equal(gh.calls.create, 1);
    assert.equal(gh.calls.update, 0);
    const firstBody = gh.comments.get(42)![0]!.body;
    assert.ok(firstBody.startsWith(COMMENT_MARKER));
    assert.ok(firstBody.includes("aaaaaaaa"));

    // Second push → same single comment, updated with the new sha.
    await postPrComment(app, await insertPlan(app, repoId, "bbbbbbbb2222"));
    assert.equal(gh.calls.create, 1); // no second comment
    assert.equal(gh.calls.update, 1);
    assert.equal(gh.comments.get(42)!.length, 1);
    assert.ok(gh.comments.get(42)![0]!.body.includes("bbbbbbbb"));

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("flag off → no GitHub calls at all", async () => {
  const gh = fakeGitHub();
  const app = await buildApp(env, { github: gh.client });
  try {
    const { orgId, projectId, repoId } = await setupRepo(app, { enabled: false, withPat: true });
    await postPrComment(app, await insertPlan(app, repoId, "cccccccc3333"));
    assert.equal(gh.calls.list, 0);
    assert.equal(gh.calls.create, 0);
    assert.equal(gh.calls.update, 0);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("marker-based idempotency survives another bot's comment", async () => {
  const gh = fakeGitHub();
  gh.comments.set(42, [{ id: 7, body: "some other bot was here" }]);
  const app = await buildApp(env, { github: gh.client });
  try {
    const { orgId, projectId, repoId } = await setupRepo(app, { enabled: true, withPat: true });
    await postPrComment(app, await insertPlan(app, repoId, "dddddddd4444"));
    // Ours is created alongside the foreign comment...
    assert.equal(gh.calls.create, 1);
    assert.equal(gh.comments.get(42)!.length, 2);
    // ...and the next push updates OURS, leaving the foreign one intact.
    await postPrComment(app, await insertPlan(app, repoId, "eeeeeeee5555"));
    assert.equal(gh.calls.update, 1);
    assert.equal(gh.comments.get(42)!.find((c) => c.id === 7)!.body, "some other bot was here");
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("missing PAT → clear error on the repo, no GitHub calls", async () => {
  const gh = fakeGitHub();
  const app = await buildApp(env, { github: gh.client });
  try {
    const { orgId, projectId, repoId } = await setupRepo(app, { enabled: true, withPat: false });
    await postPrComment(app, await insertPlan(app, repoId, "ffffffff6666"));
    assert.equal(gh.calls.create, 0);
    const [repo] = await app.db
      .select({ lastCommentError: repositories.lastCommentError })
      .from(repositories)
      .where(eq(repositories.id, repoId));
    assert.match(repo!.lastCommentError!, /no access token/i);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a GitHub API failure is recorded and never breaks ingestion", async () => {
  const failing: GitHubClient = {
    async listIssueComments() {
      return [];
    },
    async createIssueComment() {
      throw new Error("GitHub API 403: Resource not accessible (check the PAT has the 'repo' scope)");
    },
    async updateIssueComment() {
      return { id: 0, body: "" };
    },
  };
  const app = await buildApp(env, { github: failing });
  try {
    const { orgId, projectId, repoId } = await setupRepo(app, { enabled: true, withPat: true });
    const snapshot = await insertPlan(app, repoId, "99999999aaaa");
    // Does not throw — ingestion is unaffected.
    await postPrComment(app, snapshot);
    const [repo] = await app.db
      .select({ lastCommentError: repositories.lastCommentError })
      .from(repositories)
      .where(eq(repositories.id, repoId));
    assert.match(repo!.lastCommentError!, /403/);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("with a public base URL, the comment embeds a public image + share link", async () => {
  const gh = fakeGitHub();
  const app = await buildApp(
    { ...env, publicBaseUrl: "https://gp.example.com" } as AppEnv,
    { github: gh.client },
  );
  try {
    const { orgId, projectId, repoId } = await setupRepo(app, { enabled: true, withPat: true });
    await postPrComment(app, await insertPlan(app, repoId, "1212121234ab"));
    const body = gh.comments.get(42)![0]!.body;
    assert.match(body, /!\[.*\]\(https:\/\/gp\.example\.com\/api\/v1\/public\/[^)]+\/export\.png\?scope=changes\)/);
    assert.match(body, /https:\/\/gp\.example\.com\/share\//);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

// --- GitLab (GP-53) ---------------------------------------------------------

test("GitLab: creates one MR note, then updates it in place on the next push", async () => {
  const gl = fakeGitLab();
  const app = await buildApp(env, { gitlab: gl.client });
  try {
    const { orgId, projectId, repoId } = await setupRepo(app, {
      enabled: true,
      withPat: true,
      provider: "gitlab",
      url: "https://gitlab.com/acme/infra",
    });

    await postPrComment(app, await insertPlan(app, repoId, "aaaaaaaa1111"));
    assert.equal(gl.calls.create, 1);
    assert.equal(gl.calls.update, 0);
    const firstBody = gl.notes.get(42)![0]!.body;
    assert.ok(firstBody.startsWith(COMMENT_MARKER));
    assert.ok(firstBody.includes("aaaaaaaa"));

    // Second push → same single note, updated in place (idempotent via marker).
    await postPrComment(app, await insertPlan(app, repoId, "bbbbbbbb2222"));
    assert.equal(gl.calls.create, 1);
    assert.equal(gl.calls.update, 1);
    assert.equal(gl.notes.get(42)!.length, 1);
    assert.ok(gl.notes.get(42)![0]!.body.includes("bbbbbbbb"));

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("GitLab: a missing 'api' scope is recorded on the repo, never thrown", async () => {
  const failing: GitLabClient = {
    async listMergeRequestNotes() {
      return [];
    },
    async createMergeRequestNote() {
      throw new GitLabApiError(
        403,
        "GitLab API 403: insufficient_scope (check the PAT has the 'api' scope and access to this project)",
      );
    },
    async updateMergeRequestNote() {
      return { id: 0, body: "" };
    },
  };
  const app = await buildApp(env, { gitlab: failing });
  try {
    const { orgId, projectId, repoId } = await setupRepo(app, {
      enabled: true,
      withPat: true,
      provider: "gitlab",
      url: "https://gitlab.com/acme/infra",
    });
    await postPrComment(app, await insertPlan(app, repoId, "cccccccc3333"));
    const [repo] = await app.db
      .select({ lastCommentError: repositories.lastCommentError })
      .from(repositories)
      .where(eq(repositories.id, repoId));
    assert.match(repo!.lastCommentError!, /api/i);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("generic provider: comments unavailable — error stored, no provider calls", async () => {
  const gh = fakeGitHub();
  const gl = fakeGitLab();
  const app = await buildApp(env, { github: gh.client, gitlab: gl.client });
  try {
    const { orgId, projectId, repoId } = await setupRepo(app, {
      enabled: true,
      withPat: true,
      provider: "generic",
      url: "https://git.internal.example.com/acme/infra.git",
    });
    await postPrComment(app, await insertPlan(app, repoId, "dddddddd4444"));
    assert.equal(gh.calls.create + gl.calls.create, 0);
    const [repo] = await app.db
      .select({ lastCommentError: repositories.lastCommentError })
      .from(repositories)
      .where(eq(repositories.id, repoId));
    assert.match(repo!.lastCommentError!, /not available|unavailable/i);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

// --- Azure DevOps (GP-54) ---------------------------------------------------

test("Azure DevOps: creates one PR thread, then updates the comment in place", async () => {
  const ado = fakeAzureDevOps();
  const app = await buildApp(env, { azureDevOps: ado.client });
  try {
    const { orgId, projectId, repoId } = await setupRepo(app, {
      enabled: true,
      withPat: true,
      provider: "azure_devops",
      url: "https://dev.azure.com/acme/infra/_git/repo",
    });

    await postPrComment(app, await insertPlan(app, repoId, "aaaaaaaa1111"));
    assert.equal(ado.calls.create, 1);
    assert.equal(ado.calls.update, 0);
    const firstContent = ado.threads.get(42)![0]!.comments[0]!.content;
    assert.ok(firstContent.startsWith(COMMENT_MARKER));
    assert.ok(firstContent.includes("aaaaaaaa"));

    // Second push → the same single thread, comment updated in place.
    await postPrComment(app, await insertPlan(app, repoId, "bbbbbbbb2222"));
    assert.equal(ado.calls.create, 1);
    assert.equal(ado.calls.update, 1);
    assert.equal(ado.threads.get(42)!.length, 1);
    assert.ok(ado.threads.get(42)![0]!.comments[0]!.content.includes("bbbbbbbb"));

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("Azure DevOps: a permission error is recorded on the repo, never thrown", async () => {
  const failing: AzureDevOpsClient = {
    async listThreads() {
      return [];
    },
    async createThread() {
      throw new AzureDevOpsApiError(
        403,
        "Azure DevOps API 403: TF401027 (check the PAT has Code (read & write) access to post PR comments)",
      );
    },
    async updateComment() {
      return { id: 0, content: "" };
    },
  };
  const app = await buildApp(env, { azureDevOps: failing });
  try {
    const { orgId, projectId, repoId } = await setupRepo(app, {
      enabled: true,
      withPat: true,
      provider: "azure_devops",
      url: "https://dev.azure.com/acme/infra/_git/repo",
    });
    await postPrComment(app, await insertPlan(app, repoId, "cccccccc3333"));
    const [repo] = await app.db
      .select({ lastCommentError: repositories.lastCommentError })
      .from(repositories)
      .where(eq(repositories.id, repoId));
    assert.match(repo!.lastCommentError!, /403/);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
