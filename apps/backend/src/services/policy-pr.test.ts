/**
 * GP-202: the pull-request half of the policy engine. A plan that arrives from
 * CI is judged under its repository's configuration, compared with the
 * documentation of main, and the comparison is what the comment and the review
 * view both read — new violations distinguished from the estate's existing debt,
 * and what the change fixed said out loud.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { repositories } from "../db/schema.js";
import type { Graph, GraphNode } from "../graph/graph.js";
import { noRepoReads, seedOrg } from "../test-support.js";
import { insertGraphSnapshot } from "./graph-snapshots.js";
import { buildCommentBody, COMMENT_MARKER, postPrComment } from "./pr-comment.js";
import {
  evaluateRepositorySnapshot,
  evaluateSnapshotPolicy,
  getPolicyReport,
} from "./policy.js";
import type { GitHubClient, GitHubComment } from "./github.js";

/** A GitHub that records what it was asked to post. */
function fakeGitHub() {
  const posted: string[] = [];
  const client: GitHubClient = {
    ...noRepoReads,
    async listIssueComments(): Promise<GitHubComment[]> {
      return [];
    },
    async createIssueComment(_o, _r, _issue, body) {
      posted.push(body);
      return { id: 1, body };
    },
    async updateIssueComment(_o, _r, id, body) {
      posted.push(body);
      return { id, body };
    },
  };
  return { client, posted };
}

/**
 * Quiet the `orphan-resource` note for a fixture graph. These tests are about
 * one rule at a time, and a two-node graph with no edges is every node orphaned
 * — true, and beside the point here.
 */
async function withoutOrphanRule(app: FastifyInstance, orgId: string) {
  await app.inject({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/policy-config`,
    payload: { rules: { "orphan-resource": { enabled: false } } },
  });
}

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

let counter = 0;
async function createRepo(app: FastifyInstance, orgId: string) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "A", slug: `policy-pr-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id as string;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  return r.json().id as string;
}

function node(partial: Partial<GraphNode> & Pick<GraphNode, "id" | "type">): GraphNode {
  return {
    name: partial.id.split(".").pop() ?? partial.id,
    provider: "azurerm",
    module_path: [],
    change: null,
    ...partial,
  };
}

const EXPOSED = node({
  id: "azurerm_network_security_group.web",
  type: "azurerm_network_security_group",
  internet_exposed: true,
  change: "create",
});

const PRIVILEGED = node({
  id: "azurerm_role_assignment.admin",
  type: "azurerm_role_assignment",
  privileged: true,
  change: "create",
  role_assignment: {
    role: "Owner",
    principal: "azurerm_user_assigned_identity.ci",
    scope: "/subscriptions/0000",
  },
});

function graph(nodes: GraphNode[]): Graph {
  return { version: 4, nodes, edges: [] };
}

test("a plan is judged against main: new violations are told apart from pre-existing ones", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await withoutOrphanRule(app, orgId);

    // Main already carries one exposure — the estate's debt.
    const main = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "1111111",
      graph: graph([EXPOSED]),
    });
    await evaluateRepositorySnapshot(app.db, main);

    // The pull request keeps it and adds a privileged grant.
    const head = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "plan",
      ref: "refs/heads/feat",
      commitSha: "2222222",
      prNumber: 7,
      graph: graph([EXPOSED, PRIVILEGED]),
    });
    await evaluateRepositorySnapshot(app.db, head);

    const stored = await getPolicyReport(app.db, head.id);
    assert.ok(stored?.delta);
    assert.deepEqual(
      stored.delta.added.map((v) => v.ruleId),
      ["privileged-role-assignment"],
    );
    assert.deepEqual(
      stored.delta.preexisting.map((v) => v.ruleId),
      ["nsg-open-to-internet"],
    );
    assert.equal(stored.delta.status, "failing");
    assert.equal(stored.delta.baseSnapshotId, main.id);
  } finally {
    await app.close();
  }
});

test("a pull request that fixes a violation reports it as resolved", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await withoutOrphanRule(app, orgId);
    const main = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "1111111",
      graph: graph([EXPOSED]),
    });
    await evaluateRepositorySnapshot(app.db, main);

    const head = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "plan",
      ref: "refs/heads/fix",
      commitSha: "3333333",
      prNumber: 8,
      graph: graph([
        node({
          id: "azurerm_network_security_group.web",
          type: "azurerm_network_security_group",
          change: "update",
        }),
      ]),
    });
    await evaluateRepositorySnapshot(app.db, head);

    const stored = await getPolicyReport(app.db, head.id);
    assert.deepEqual(
      stored?.delta?.resolved.map((v) => v.ruleId),
      ["nsg-open-to-internet"],
    );
    assert.equal(stored?.delta?.status, "passing");
  } finally {
    await app.close();
  }
});

test("the repository's own configuration decides the verdict", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await withoutOrphanRule(app, orgId);
    await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/policy-config`,
      payload: { rules: { "nsg-open-to-internet": { severity: "info" } } },
    });

    const head = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "plan",
      ref: "refs/heads/feat",
      commitSha: "4444444",
      prNumber: 9,
      graph: graph([EXPOSED]),
    });
    await evaluateRepositorySnapshot(app.db, head);

    const stored = await getPolicyReport(app.db, head.id);
    assert.equal(stored?.report.violations[0]?.severity, "info");
    assert.equal(stored?.delta?.status, "passing");
  } finally {
    await app.close();
  }
});

test("a Kubernetes snapshot is judged only by the rules that can judge it", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    const head = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "k8s_rendered",
      ref: "refs/heads/feat",
      commitSha: "5555555",
      prNumber: 10,
      graph: graph([
        node({ id: "default/ConfigMap/unused", type: "ConfigMap", provider: "kubernetes" }),
      ]),
    });
    const row = await evaluateSnapshotPolicy(app.db, head);

    const nsg = row.report.rules.find((r) => r.ruleId === "nsg-open-to-internet");
    assert.equal(nsg?.applicable, false, "an azurerm rule gives no verdict here");
    assert.equal(row.report.target, "kubernetes");
    // The rule that *does* understand a Kubernetes graph still ran.
    assert.deepEqual(
      row.report.violations.map((v) => v.ruleId),
      ["orphan-resource"],
    );
  } finally {
    await app.close();
  }
});

test("the pull-request comment carries the Policy section", async () => {
  const { client, posted } = fakeGitHub();
  const app = await buildApp(env, { github: client });
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await withoutOrphanRule(app, orgId);
    await app.db
      .update(repositories)
      .set({ prCommentsEnabled: true, accessToken: app.encryptor.encrypt("t") })
      .where(eq(repositories.id, repoId));

    const head = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "plan",
      ref: "refs/heads/feat",
      commitSha: "6666666",
      prNumber: 11,
      graph: graph([EXPOSED]),
    });
    await evaluateRepositorySnapshot(app.db, head);
    await postPrComment(app, head);

    assert.equal(posted.length, 1);
    const body = posted[0]!;
    assert.ok(body.startsWith(COMMENT_MARKER));
    assert.match(body, /\*\*Policy: failing\*\*/);
    assert.match(body, /New violations/);
    assert.match(body, /nsg-open-to-internet/);
  } finally {
    await app.close();
  }
});

test("a comment for an unjudged snapshot simply has no Policy section", () => {
  const body = buildCommentBody({
    repoLabel: "acme/infra",
    ref: "main",
    commitSha: "abcd1234",
    summaryMd: "No changes.",
    policyMd: null,
    imageUrl: null,
    viewUrl: null,
  });
  assert.ok(!body.includes("Policy"));
});
