/**
 * Kind detection over the wire (GP-228): the import screen asking what the
 * repositories on the page it is showing actually hold.
 *
 * The assertions that matter are the cheap-and-honest ones: one tree call per
 * repository, no clone, and never a `high` verdict on a truncated tree or an
 * ambiguous repository.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { buildApp } from "../app.js";
import { loadEnv, type AppEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { integrationCredentials } from "../db/schema.js";
import type { GitHubAppClient } from "../integrations/adapters/github-app.js";
import type { GitHubClient, GitHubTree } from "../services/github.js";
import { invalidateKindCache } from "../services/repo-kind-detect.js";
import { noRepoReads, seedOrg } from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function appEnv(): AppEnv {
  return {
    ...env,
    githubAppId: "12345",
    githubAppPrivateKey: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    githubAppSlug: "groundplan",
    publicBaseUrl: "https://gp.example.com",
  };
}

const stubAppClient: GitHubAppClient = {
  getInstallation: async (id) => ({ id, account: "acme" }),
  createInstallationToken: async () => ({
    token: "ghs_x",
    expiresAt: new Date(Date.now() + 3_600_000),
  }),
  listInstallationRepositories: async () => ({ repositories: [], totalCount: 0 }),
};

/** A GitHub whose only job is to answer tree/content reads, and to count them. */
function fakeTreeGitHub(
  trees: Record<string, GitHubTree>,
  contents: Record<string, string> = {},
) {
  const calls = { tree: 0, file: 0 };
  const client: GitHubClient = {
    ...noRepoReads,
    listIssueComments: async () => [],
    createIssueComment: async () => ({ id: 1, body: "" }),
    updateIssueComment: async () => ({ id: 1, body: "" }),
    getTree: async (owner, repo) => {
      calls.tree += 1;
      return trees[`${owner}/${repo}`] ?? { tree: [], truncated: false };
    },
    getFileHead: async (owner, repo, _ref, path) => {
      calls.file += 1;
      return contents[`${owner}/${repo}:${path}`] ?? null;
    },
  };
  return { client, calls };
}

const blob = (path: string) => ({ path, type: "blob" });

async function seedConnection(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
) {
  await app.db.insert(integrationCredentials).values({
    organizationId: orgId,
    provider: "github",
    mode: "installation_app",
    name: "acme",
    config: { installationId: 42, account: "acme" },
    secret: null,
    status: "ok",
  });
}

type Detection = {
  fullName: string;
  kind: string | null;
  confidence: string;
  evidence: string[];
  suggestedPath: string | null;
  truncated: boolean;
};

async function detect(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
  repositories: { owner: string; name: string; ref?: string; path?: string }[],
): Promise<Detection[]> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/integrations/github/repositories/detect`,
    payload: { repositories },
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { detections: Detection[] }).detections;
}

test("a Terraform repo, a chart and a monorepo are told apart in one call", async () => {
  const { client, calls } = fakeTreeGitHub({
    "acme/tf": {
      tree: [blob("main.tf"), blob("variables.tf"), blob("README.md")],
      truncated: false,
    },
    "acme/chart": {
      tree: [blob("Chart.yaml"), blob("templates/deploy.yaml")],
      truncated: false,
    },
    "acme/mono": {
      tree: [blob("infra/main.tf"), blob("k8s/deploy.yaml")],
      truncated: false,
    },
  }, {
    "acme/mono:k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\n",
  });

  const app = await buildApp(appEnv(), { github: client, githubApp: stubAppClient });
  const orgId = await seedOrg(app);
  invalidateKindCache();
  try {
    await seedConnection(app, orgId);
    const detections = await detect(app, orgId, [
      { owner: "acme", name: "tf" },
      { owner: "acme", name: "chart" },
      { owner: "acme", name: "mono" },
    ]);

    const byName = new Map(detections.map((d) => [d.fullName, d]));
    assert.equal(byName.get("acme/tf")!.kind, "terraform");
    assert.equal(byName.get("acme/tf")!.confidence, "high");
    assert.equal(byName.get("acme/chart")!.kind, "kubernetes");
    assert.equal(byName.get("acme/chart")!.confidence, "high");

    // The monorepo: no kind, both evidences, and no path guessed for it.
    const mono = byName.get("acme/mono")!;
    assert.equal(mono.kind, null);
    assert.equal(mono.confidence, "low");
    assert.ok(mono.evidence.includes("infra/main.tf"));
    assert.ok(mono.evidence.includes("k8s/deploy.yaml"));

    assert.equal(calls.tree, 3, "exactly one tree call per repository");
  } finally {
    await app.close();
  }
});

test("raw manifests need the head keys — and only a bounded peek at them", async () => {
  const { client, calls } = fakeTreeGitHub(
    {
      "acme/manifests": {
        tree: [
          blob("deployment.yaml"),
          blob("service.yaml"),
          blob("ingress.yaml"),
          blob(".github/workflows/ci.yaml"),
        ],
        truncated: false,
      },
    },
    {
      "acme/manifests:deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\n",
      "acme/manifests:service.yaml": "apiVersion: v1\nkind: Service\n",
      "acme/manifests:ingress.yaml": "apiVersion: networking.k8s.io/v1\nkind: Ingress\n",
    },
  );
  const app = await buildApp(appEnv(), { github: client, githubApp: stubAppClient });
  const orgId = await seedOrg(app);
  invalidateKindCache();
  try {
    await seedConnection(app, orgId);
    const [detection] = await detect(app, orgId, [
      { owner: "acme", name: "manifests" },
    ]);
    assert.equal(detection!.kind, "kubernetes");
    assert.equal(detection!.confidence, "high");
    assert.equal(calls.tree, 1, "still one tree call");
    assert.ok(calls.file <= 5, "the content peek is bounded");
    assert.ok(calls.file >= 1, "…and it did happen — the names alone say nothing");
  } finally {
    await app.close();
  }
});

test("a repo of CI YAML is not Kubernetes, however much YAML it holds", async () => {
  const { client } = fakeTreeGitHub(
    {
      "acme/app": {
        tree: [blob("docker-compose.yml"), blob("config/settings.yaml")],
        truncated: false,
      },
    },
    {
      "acme/app:docker-compose.yml": "services:\n  api:\n    image: api\n",
      "acme/app:config/settings.yaml": "log_level: debug\n",
    },
  );
  const app = await buildApp(appEnv(), { github: client, githubApp: stubAppClient });
  const orgId = await seedOrg(app);
  invalidateKindCache();
  try {
    await seedConnection(app, orgId);
    const [detection] = await detect(app, orgId, [{ owner: "acme", name: "app" }]);
    assert.equal(detection!.kind, null);
    assert.equal(detection!.confidence, "low");
  } finally {
    await app.close();
  }
});

test("a truncated tree is reported and never confident", async () => {
  const { client } = fakeTreeGitHub({
    "acme/huge": { tree: [blob("main.tf")], truncated: true },
  });
  const app = await buildApp(appEnv(), { github: client, githubApp: stubAppClient });
  const orgId = await seedOrg(app);
  invalidateKindCache();
  try {
    await seedConnection(app, orgId);
    const [detection] = await detect(app, orgId, [{ owner: "acme", name: "huge" }]);
    assert.equal(detection!.kind, "terraform");
    assert.equal(detection!.confidence, "low");
    assert.equal(detection!.truncated, true);
  } finally {
    await app.close();
  }
});

test("an empty repository yields no kind at all", async () => {
  const { client } = fakeTreeGitHub({
    "acme/empty": { tree: [], truncated: false },
  });
  const app = await buildApp(appEnv(), { github: client, githubApp: stubAppClient });
  const orgId = await seedOrg(app);
  invalidateKindCache();
  try {
    await seedConnection(app, orgId);
    const [detection] = await detect(app, orgId, [{ owner: "acme", name: "empty" }]);
    assert.equal(detection!.kind, null);
    assert.deepEqual(detection!.evidence, []);
  } finally {
    await app.close();
  }
});

test("a repository we cannot read is unknown, and does not blank the page", async () => {
  const failing: GitHubClient = {
    ...noRepoReads,
    listIssueComments: async () => [],
    createIssueComment: async () => ({ id: 1, body: "" }),
    updateIssueComment: async () => ({ id: 1, body: "" }),
    getTree: async (_owner, repo) => {
      if (repo === "broken") throw new Error("GitHub API 500: upstream is unwell");
      return { tree: [blob("main.tf")], truncated: false };
    },
    getFileHead: async () => null,
  };
  const app = await buildApp(appEnv(), { github: failing, githubApp: stubAppClient });
  const orgId = await seedOrg(app);
  invalidateKindCache();
  try {
    await seedConnection(app, orgId);
    const detections = await detect(app, orgId, [
      { owner: "acme", name: "broken" },
      { owner: "acme", name: "fine" },
    ]);
    const byName = new Map(detections.map((d) => [d.fullName, d]));
    assert.equal(byName.get("acme/broken")!.kind, null, "unknown, not an error");
    assert.equal(
      byName.get("acme/fine")!.kind,
      "terraform",
      "one bad repository does not cost the others their detection",
    );
  } finally {
    await app.close();
  }
});

test("a suggested path is offered when everything sits in one directory", async () => {
  const { client } = fakeTreeGitHub({
    "acme/platform": {
      tree: [blob("infra/main.tf"), blob("infra/vars.tf"), blob("docs/readme.md")],
      truncated: false,
    },
  });
  const app = await buildApp(appEnv(), { github: client, githubApp: stubAppClient });
  const orgId = await seedOrg(app);
  invalidateKindCache();
  try {
    await seedConnection(app, orgId);
    const [detection] = await detect(app, orgId, [
      { owner: "acme", name: "platform" },
    ]);
    assert.equal(detection!.kind, "terraform");
    assert.equal(detection!.suggestedPath, "infra");
  } finally {
    await app.close();
  }
});

test("detection can be scoped to a path — the monorepo, resolved twice", async () => {
  const { client } = fakeTreeGitHub(
    {
      "acme/mono": {
        tree: [blob("infra/main.tf"), blob("k8s/deploy.yaml")],
        truncated: false,
      },
    },
    { "acme/mono:k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\n" },
  );
  const app = await buildApp(appEnv(), { github: client, githubApp: stubAppClient });
  const orgId = await seedOrg(app);
  invalidateKindCache();
  try {
    await seedConnection(app, orgId);
    const detections = await detect(app, orgId, [
      { owner: "acme", name: "mono", path: "infra" },
      { owner: "acme", name: "mono", path: "k8s" },
    ]);
    assert.equal(detections[0]!.kind, "terraform");
    assert.equal(detections[1]!.kind, "kubernetes");
  } finally {
    await app.close();
  }
});

test("detections are cached, so paging back does not re-read the tree", async () => {
  const { client, calls } = fakeTreeGitHub({
    "acme/tf": { tree: [blob("main.tf")], truncated: false },
  });
  const app = await buildApp(appEnv(), { github: client, githubApp: stubAppClient });
  const orgId = await seedOrg(app);
  invalidateKindCache();
  try {
    await seedConnection(app, orgId);
    await detect(app, orgId, [{ owner: "acme", name: "tf" }]);
    await detect(app, orgId, [{ owner: "acme", name: "tf" }]);
    assert.equal(calls.tree, 1, "the second look costs nothing");
  } finally {
    await app.close();
  }
});
