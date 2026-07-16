import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { mapK8sObjects } from "../graph/k8s-mapper.js";
import { parseManifestStream } from "../graph/manifest-parser.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import { COMMENT_MARKER } from "../services/pr-comment.js";
import type { GitHubClient, GitHubComment } from "../services/github.js";
import { seedOrg } from "../test-support.js";

/**
 * The Kubernetes pull-request flow (GP-103): the user's CI renders the head and
 * posts it; we colour it against what main says today and store the PR's snapshot.
 * The Terraform experience, for Kubernetes — and, as the tests below insist,
 * through the same machinery.
 *
 * Nothing here renders a chart, and nothing here reaches a network: `helm` and
 * `kustomize` run in the user's CI, which is the whole point of the design.
 */
const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

/** What main says today: an api at 1.4.0, a service, and a config to be removed. */
const MAIN_MANIFESTS = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
spec:
  replicas: 2
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: acme/api:1.4.0
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: legacy
  namespace: prod
data:
  OLD: "1"
`;

/** What the pull request would make it say: new image, a service added, config gone. */
const HEAD_MANIFESTS = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
spec:
  replicas: 2
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: acme/api:1.5.0
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: prod
spec:
  selector:
    app: api
  ports:
    - port: 80
`;

let counter = 0;

function fakeGitHub() {
  const comments = new Map<number, GitHubComment[]>();
  const calls = { list: 0, create: 0, update: 0 };
  let nextId = 500;
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

async function createK8sRepo(
  app: FastifyInstance,
  orgId: string,
  opts: { prComments?: boolean } = {},
): Promise<{ projectId: string; repoId: string; token: string }> {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "K", slug: `k8sci-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: {
      provider: "github",
      url: "https://github.com/acme/manifests",
      iacType: "kubernetes",
      ...(opts.prComments ? { accessToken: "ghp_test" } : {}),
    },
  });
  const repo = r.json();
  if (opts.prComments) {
    await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}`,
      payload: { prCommentsEnabled: true },
    });
  }
  return { projectId, repoId: repo.id, token: repo.webhookToken };
}

/** Post rendered manifests the way the CI snippet does. */
function render(
  app: FastifyInstance,
  repoId: string,
  token: string,
  manifests: string,
  over: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/ci/${repoId}`,
    headers: { "x-groundplan-token": token },
    payload: {
      event: "pull_request",
      ref: "refs/heads/feat",
      commit_sha: "head1111",
      pr_number: 7,
      pr_title: "Bump the api",
      payload: { manifests },
      ...over,
    },
  });
}

test("a rendered pull request is coloured against main: update, create, delete", async () => {
  const gh = fakeGitHub();
  const app = await buildApp(env, { github: gh.client });
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId, token } = await createK8sRepo(app, orgId, { prComments: true });

    // Main's diagram, as GP-102's producer would have stored it on the last merge.
    // (That path is covered end-to-end, with a real clone, in k8s-docs.test.ts.)
    const base = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "k8s_manifest",
      ref: "main",
      commitSha: "main0000",
      prNumber: null,
      graph: mapK8sObjects(parseManifestStream(MAIN_MANIFESTS)),
    });

    const res = await render(app, repoId, token, HEAD_MANIFESTS);
    assert.equal(res.statusCode, 202);
    assert.ok(res.json().id, "the event is acknowledged like any other");
    await app.flushBackgroundTasks();

    const snapshots = (
      await app.inject({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots?pr_number=7`,
      })
    ).json();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].source, "k8s_rendered");

    const snapshot = (
      await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${snapshots[0].id}` })
    ).json();

    // The three colours a reviewer came for.
    const change = (id: string) =>
      snapshot.graph.nodes.find((n: { id: string }) => n.id === id)?.change;
    assert.equal(change("prod/Deployment/api"), "update");
    assert.equal(change("prod/Service/api"), "create");
    assert.equal(change("prod/ConfigMap/legacy"), "delete");

    // And the reason for the colour, which is what makes it reviewable.
    const api = snapshot.graph.nodes.find(
      (n: { id: string }) => n.id === "prod/Deployment/api",
    );
    assert.deepEqual(
      api.attribute_diff.filter((r: { key: string }) => r.key.endsWith("image")),
      [
        {
          key: "spec.template.spec.containers[0].image",
          before: "acme/api:1.4.0",
          after: "acme/api:1.5.0",
        },
      ],
    );

    // It says what it compared against. A diff whose other side you cannot name
    // is not a diff, it is an assertion.
    assert.equal(snapshot.stats.base, base.id);
    assert.equal(snapshot.stats.baseCommitSha, "main0000");
    assert.equal(snapshot.stats.changes.create, 1);
    assert.equal(snapshot.stats.changes.update, 1);
    assert.equal(snapshot.stats.changes.delete, 1);

    // The pull request itself was fed exactly as a Terraform one is (GP-14).
    const pull = (
      await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/repositories/${repoId}/pulls/7` })
    ).json();
    assert.equal(pull.title, "Bump the api");
    assert.equal(pull.latestSnapshot.id, snapshots[0].id);

    // The deterministic summary speaks Kubernetes, and the PR comment carries it.
    assert.match(snapshot.summaryMd, /Deployment/);
    assert.equal(gh.calls.create, 1);
    const comment = gh.comments.get(7)![0]!.body;
    assert.ok(comment.startsWith(COMMENT_MARKER));
    assert.match(comment, /Service/);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a repository whose main has no diagram yet compares against nothing, and says so", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId, token } = await createK8sRepo(app, orgId);

    const res = await render(app, repoId, token, HEAD_MANIFESTS);
    assert.equal(res.statusCode, 202);
    await app.flushBackgroundTasks();

    const [summary] = (
      await app.inject({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots?pr_number=7`,
      })
    ).json();
    const snapshot = (
      await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${summary.id}` })
    ).json();

    // Everything is new — which is true, and is not the same as nothing changing.
    assert.equal(snapshot.stats.base, "none");
    assert.ok(snapshot.graph.nodes.every((n: { change: string }) => n.change === "create"));
    assert.equal(snapshot.stats.changes.delete, 0);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("CI retrying the same commit replaces its diagram — two of one commit is not history", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId, token } = await createK8sRepo(app, orgId);

    await render(app, repoId, token, HEAD_MANIFESTS);
    await render(app, repoId, token, HEAD_MANIFESTS);
    await app.flushBackgroundTasks();

    const snapshots = (
      await app.inject({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots?pr_number=7`,
      })
    ).json();
    assert.equal(snapshots.length, 1, "the re-delivery replaced, it did not stack");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a body we cannot read is refused, and nothing is stored", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId, token } = await createK8sRepo(app, orgId);

    // Malformed YAML: the CI step should fail, now, where somebody is watching.
    const broken = await render(app, repoId, token, "kind: Deployment\n  bad: [indent\n");
    assert.equal(broken.statusCode, 422);
    assert.match(broken.json().message, /not valid YAML/);

    // A render that produced nothing is a broken render, not an empty diagram.
    const empty = await render(app, repoId, token, "# nothing here\n");
    assert.equal(empty.statusCode, 422);
    assert.match(empty.json().message, /no Kubernetes objects/);

    // The plan a kubernetes repository has no business sending.
    const plan = await render(app, repoId, token, "", {
      payload: { format_version: "1.2", resource_changes: [] },
    });
    assert.equal(plan.statusCode, 422);

    assert.deepEqual(
      (await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/repositories/${repoId}/events` })).json(),
      [],
      "a refused delivery is not an event",
    );
    assert.deepEqual(
      (
        await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots` })
      ).json(),
      [],
    );

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("the dashboard's chips light up for a kubernetes pull request", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId, token } = await createK8sRepo(app, orgId);
    await render(app, repoId, token, HEAD_MANIFESTS);
    await app.flushBackgroundTasks();

    const dashboard = (await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/dashboard` })).json();
    const pull = dashboard.recentPrs.find(
      (p: { repositoryId: string }) => p.repositoryId === repoId,
    );
    // The dashboard was never taught about Kubernetes: it asks for the snapshot
    // that describes a pull request's head, and this is one.
    assert.ok(pull, "the pull request is on the dashboard");
    assert.equal(pull.latestSnapshot.stats.changes.create, 3);
    assert.equal(pull.internetExposed, false, "no Terraform risk flags on a k8s graph");
    assert.equal(pull.privileged, false);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a terraform repository is untouched by any of this", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    counter += 1;
    const p = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects`,
      payload: { name: "T", slug: `tfci-${Date.now()}-${counter}` },
    });
    const projectId = p.json().id;
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
      payload: { provider: "github", url: "https://github.com/acme/infra" },
    });
    const { id: repoId, webhookToken } = r.json();

    // Manifests posted to a Terraform repository are not manifests, they are an
    // object with a string in it — and the plan parser rightly ignores them.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      headers: { "x-groundplan-token": webhookToken },
      payload: {
        event: "pull_request",
        ref: "refs/heads/feat",
        commit_sha: "abc123",
        pr_number: 1,
        payload: { manifests: HEAD_MANIFESTS },
      },
    });
    assert.equal(res.statusCode, 202, "still accepted, still stored as an event");
    await app.flushBackgroundTasks();
    assert.deepEqual(
      (
        await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots` })
      ).json(),
      [],
      "and no snapshot, because it is not a plan",
    );

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a chart's main is documented from the render its CI already does", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId, token } = await createK8sRepo(app, orgId);

    // A Helm chart has nothing in it we can read — its templates are Go source —
    // so main's diagram comes from CI rendering it on merge, and *that* is what a
    // later pull request is coloured against.
    const merge = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      headers: { "x-groundplan-token": token },
      payload: {
        event: "push",
        ref: "refs/heads/main",
        commit_sha: "main0001",
        payload: { manifests: MAIN_MANIFESTS },
      },
    });
    assert.equal(merge.statusCode, 202);
    await app.flushBackgroundTasks();

    const docs = (
      await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/repositories/${repoId}/docs/latest` })
    ).json();
    assert.equal(docs.source, "k8s_manifest", "it is documentation, not a review");
    assert.equal(docs.commitSha, "main0001");
    assert.equal(docs.prNumber, null);
    assert.equal(docs.stats.rendered, true, "and it says where it came from");
    assert.ok(
      docs.graph.nodes.every((n: { change: null }) => n.change === null),
      "documentation of a branch is a state, not a change",
    );

    // And now the pull request has something true to be compared against.
    await render(app, repoId, token, HEAD_MANIFESTS);
    await app.flushBackgroundTasks();
    const [pr] = (
      await app.inject({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots?pr_number=7`,
      })
    ).json();
    const snapshot = (
      await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${pr.id}` })
    ).json();
    assert.equal(snapshot.stats.base, docs.id);
    assert.equal(snapshot.stats.changes.update, 1, "the image moved");
    assert.equal(snapshot.stats.changes.delete, 1, "the config went");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
