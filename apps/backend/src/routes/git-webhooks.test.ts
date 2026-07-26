/**
 * The git webhook endpoint (GP-194): who is allowed in, what a delivery does,
 * and — the point of the story — that a fact acted on once is not acted on
 * twice when the poller sees it too.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv, type AppEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import {
  projects,
  pullRequests,
  refEventDeliveries,
  repositories,
  type RepositoryRow,
} from "../db/schema.js";
import { handleRefEvent } from "../services/ref-events.js";
import { shouldSkipPoll } from "../services/ref-poller.js";
import { seedOrg } from "../test-support.js";
import { sameRepository } from "./git-webhooks.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

const APP_SECRET = "app-webhook-secret";

function webhookEnv(): AppEnv {
  return {
    ...env,
    // A GitHub App with a webhook secret; the key content is irrelevant here.
    githubAppId: "12345",
    githubAppPrivateKey: "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
    githubAppSlug: "groundplan",
    githubAppWebhookSecret: APP_SECRET,
  };
}

/**
 * A URL nothing else in the suite uses. Deliveries are matched by URL across
 * every tenant on purpose — two orgs may watch the same repository — so a test
 * that shares one with its neighbours would count their repositories too.
 */
function uniqueRepoUrl(host = "github.com"): string {
  return `https://${host}/acme/infra-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function seedRepo(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
  overrides: Partial<typeof repositories.$inferInsert> = {},
): Promise<RepositoryRow> {
  const [project] = await app.db
    .insert(projects)
    .values({
      organizationId: orgId,
      name: "Platform",
      slug: `platform-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    })
    .returning({ id: projects.id });
  const [repo] = await app.db
    .insert(repositories)
    .values({
      projectId: project!.id,
      provider: "github",
      url: uniqueRepoUrl(),
      ...overrides,
    })
    .returning();
  return repo!;
}

function githubDelivery(event: string, body: unknown, secret = APP_SECRET) {
  const payload = JSON.stringify(body);
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  return {
    payload,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${digest}`,
    },
  };
}

/** The pull_request payload GitHub sends, pointed at one repository. */
function prBody(cloneUrl: string) {
  return {
    action: "opened",
    number: 7,
    pull_request: {
      title: "Add the VNet",
      state: "open",
      head: { ref: "feature/vnet", sha: "beef22" },
    },
    repository: { clone_url: `${cloneUrl}.git` },
  };
}

test("sameRepository ignores .git, trailing slashes and case", () => {
  assert.ok(
    sameRepository("https://github.com/acme/infra", "https://github.com/acme/infra.git"),
  );
  assert.ok(
    sameRepository("https://GitHub.com/Acme/Infra/", "https://github.com/acme/infra"),
  );
  assert.equal(
    sameRepository("https://github.com/acme/infra", "https://github.com/acme/other"),
    false,
  );
  assert.equal(sameRepository("not a url", "https://github.com/acme/infra"), false);
});

test("a signed pull_request delivery upserts the PR and marks the webhook alive", async () => {
  const app = await buildApp(webhookEnv());
  const orgId = await seedOrg(app);
  try {
    const repo = await seedRepo(app, orgId);
    const { payload, headers } = githubDelivery("pull_request", prBody(repo.url));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/git/github",
      payload,
      headers,
    });
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(res.json().handled, 1);

    const [pr] = await app.db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, repo.id));
    assert.equal(pr!.number, 7);
    assert.equal(pr!.state, "open");
    assert.equal(pr!.sourceRef, "feature/vnet");

    const [after] = await app.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repo.id));
    assert.ok(after!.webhookSeenAt, "the repository is now hearing from its provider");
  } finally {
    await app.close();
  }
});

test("the same delivery twice does the work once", async () => {
  const app = await buildApp(webhookEnv());
  const orgId = await seedOrg(app);
  try {
    const repo = await seedRepo(app, orgId);
    const { payload, headers } = githubDelivery("pull_request", prBody(repo.url));

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/git/github",
      payload,
      headers,
    });
    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/git/github",
      payload,
      headers,
    });

    assert.equal(first.json().handled, 1);
    assert.equal(retry.statusCode, 202, "a retry is accepted…");
    assert.equal(retry.json().handled, 0, "…and changes nothing");

    const deliveries = await app.db
      .select()
      .from(refEventDeliveries)
      .where(eq(refEventDeliveries.repositoryId, repo.id));
    assert.equal(deliveries.length, 1, "one fact, one row");
  } finally {
    await app.close();
  }
});

test("a fact the webhook handled is not handled again by the poller", async () => {
  const app = await buildApp(webhookEnv());
  const orgId = await seedOrg(app);
  try {
    const repo = await seedRepo(app, orgId);
    const { payload, headers } = githubDelivery("pull_request", prBody(repo.url));
    await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/git/github",
      payload,
      headers,
    });

    // The poller, seeing the same branch at the same sha, claims nothing.
    const acted = await handleRefEvent(
      app,
      repo,
      {
        kind: "pull_request",
        branch: "feature/vnet",
        sha: "beef22",
        prNumber: 7,
        remoteUrl: null,
      },
      "poller",
    );
    assert.equal(acted, false);

    const rows = await app.db
      .select()
      .from(refEventDeliveries)
      .where(
        and(
          eq(refEventDeliveries.repositoryId, repo.id),
          eq(refEventDeliveries.source, "webhook"),
        ),
      );
    assert.equal(rows.length, 1, "the webhook got there first and stays the owner");
  } finally {
    await app.close();
  }
});

test("a bad signature is 401 and touches nothing", async () => {
  const app = await buildApp(webhookEnv());
  const orgId = await seedOrg(app);
  try {
    const repo = await seedRepo(app, orgId);
    const { payload, headers } = githubDelivery(
      "pull_request",
      prBody(repo.url),
      "wrong-secret",
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/git/github",
      payload,
      headers,
    });
    assert.equal(res.statusCode, 401);

    const prs = await app.db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, repo.id));
    assert.deepEqual(prs, []);
  } finally {
    await app.close();
  }
});

test("an unknown repository answers 401 too — this endpoint enumerates nothing", async () => {
  const app = await buildApp(webhookEnv());
  await seedOrg(app);
  try {
    const { payload, headers } = githubDelivery(
      "pull_request",
      prBody("https://github.com/someone/else-that-is-not-attached"),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/git/github",
      payload,
      headers,
    });
    assert.equal(res.statusCode, 401, "the same answer as a bad secret");
  } finally {
    await app.close();
  }
});

test("a repository's own webhook token authenticates a GitLab delivery", async () => {
  const app = await buildApp(env); // no GitHub App configured at all
  const orgId = await seedOrg(app);
  try {
    const repo = await seedRepo(app, orgId, {
      provider: "gitlab",
      url: uniqueRepoUrl("gitlab.com"),
    });

    const body = {
      object_attributes: {
        iid: 3,
        title: "Add the subnet",
        state: "opened",
        source_branch: "feature/subnet",
        last_commit: { id: "beef33" },
      },
      project: { git_http_url: `${repo.url}.git` },
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/git/gitlab",
      payload: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Merge Request Hook",
        "x-gitlab-token": repo.webhookToken,
      },
    });
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(res.json().handled, 1);

    const [pr] = await app.db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, repo.id));
    assert.equal(pr!.number, 3);
  } finally {
    await app.close();
  }
});

test("a payload over the cap is refused before anything is read", async () => {
  const app = await buildApp(webhookEnv());
  try {
    const huge = "x".repeat(3 * 1024 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/git/github",
      payload: JSON.stringify({ pad: huge }),
      headers: { "content-type": "application/json", "x-github-event": "push" },
    });
    assert.equal(res.statusCode, 413);
  } finally {
    await app.close();
  }
});

test("a ping is accepted and does nothing", async () => {
  const app = await buildApp(webhookEnv());
  try {
    const { payload, headers } = githubDelivery("ping", { zen: "Keep it logically awesome" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/git/github",
      payload,
      headers,
    });
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().handled, 0);
  } finally {
    await app.close();
  }
});

test("the poller backs off for a repository hearing webhooks, and only then", () => {
  const now = Date.now();
  const base = { lastPolledAt: new Date(now - 60_000) } as RepositoryRow;

  assert.equal(
    shouldSkipPoll({ ...base, webhookSeenAt: null } as RepositoryRow, now),
    false,
    "a self-host with no inbound webhooks is polled exactly as before",
  );
  assert.equal(
    shouldSkipPoll(
      { ...base, webhookSeenAt: new Date(now - 60_000) } as RepositoryRow,
      now,
    ),
    true,
    "recently delivered and recently polled: the poller stands down",
  );
  assert.equal(
    shouldSkipPoll(
      {
        ...base,
        webhookSeenAt: new Date(now - 60_000),
        lastPolledAt: new Date(now - 30 * 60_000),
      } as RepositoryRow,
      now,
    ),
    false,
    "the safety-net pass still runs once a window",
  );
  assert.equal(
    shouldSkipPoll(
      { ...base, webhookSeenAt: new Date(now - 60 * 60_000) } as RepositoryRow,
      now,
    ),
    false,
    "a webhook that went quiet gives full polling back",
  );
});
