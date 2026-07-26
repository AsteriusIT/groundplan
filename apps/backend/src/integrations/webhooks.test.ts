/**
 * Webhook verification and normalization (GP-194). Replays a payload per
 * provider — trimmed to the fields we read, in the shape the provider actually
 * sends — and asserts the events they become. Pure functions, no app, no DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  azureDevOpsRefEvents,
  githubRefEvents,
  gitlabRefEvents,
} from "./webhooks.js";
import type { RawWebhook } from "./types.js";

const SECRET = "s3cret-webhook-token";
const ZERO = "0".repeat(40);

function hook(
  headers: Record<string, string>,
  body: unknown,
  rawOverride?: Buffer,
): RawWebhook {
  const rawBody = rawOverride ?? Buffer.from(JSON.stringify(body), "utf8");
  return { headers, rawBody, json: body };
}

function githubSigned(
  event: string,
  body: unknown,
  secret = SECRET,
): RawWebhook {
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  return {
    headers: {
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${digest}`,
    },
    rawBody,
    json: body,
  };
}

/* --- GitHub --------------------------------------------------------------- */

test("github: a delivery signed with the app secret verifies", () => {
  const delivery = githubSigned("push", { ref: "refs/heads/main" });
  assert.equal(githubRefEvents.verifySignature(delivery, SECRET), true);
});

test("github: a wrong secret, a missing header and a tampered body all fail", () => {
  const body = { ref: "refs/heads/main", after: "abc" };
  const delivery = githubSigned("push", body);

  assert.equal(githubRefEvents.verifySignature(delivery, "other-secret"), false);
  assert.equal(
    githubRefEvents.verifySignature(hook({ "x-github-event": "push" }, body), SECRET),
    false,
    "no signature header is not a pass",
  );

  // Same signature, different bytes: this is why the raw body is kept.
  const tampered: RawWebhook = {
    ...delivery,
    rawBody: Buffer.from(JSON.stringify({ ...body, after: "deadbeef" }), "utf8"),
  };
  assert.equal(githubRefEvents.verifySignature(tampered, SECRET), false);
});

test("github: a push becomes one push event carrying its remote", () => {
  const events = githubRefEvents.parseEvents(
    githubSigned("push", {
      ref: "refs/heads/main",
      after: "aaa111",
      before: "000999",
      repository: { clone_url: "https://github.com/acme/infra.git" },
    }),
  );
  assert.deepEqual(events, [
    {
      kind: "push",
      branch: "main",
      sha: "aaa111",
      remoteUrl: "https://github.com/acme/infra.git",
    },
  ]);
});

test("github: a deleted branch is a deletion, not a push to nothing", () => {
  const events = githubRefEvents.parseEvents(
    githubSigned("push", {
      ref: "refs/heads/feature/x",
      after: ZERO,
      before: "cafe01",
      deleted: true,
      repository: { clone_url: "https://github.com/acme/infra.git" },
    }),
  );
  assert.equal(events[0]?.kind, "branch_deleted");
  assert.equal(events[0]?.branch, "feature/x");
  assert.equal(events[0]?.sha, "cafe01", "the last sha we knew, for the record");
});

test("github: a tag push is not a branch event", () => {
  const events = githubRefEvents.parseEvents(
    githubSigned("push", { ref: "refs/tags/v1.0.0", after: "aaa111" }),
  );
  assert.deepEqual(events, []);
});

test("github: a pull request carries its number, head and state", () => {
  const events = githubRefEvents.parseEvents(
    githubSigned("pull_request", {
      action: "synchronize",
      number: 42,
      pull_request: {
        title: "Add the VNet",
        state: "open",
        head: { ref: "feature/vnet", sha: "beef22" },
      },
      repository: { clone_url: "https://github.com/acme/infra.git" },
    }),
  );
  assert.deepEqual(events, [
    {
      kind: "pull_request",
      branch: "feature/vnet",
      sha: "beef22",
      prNumber: 42,
      prTitle: "Add the VNet",
      prState: "open",
      remoteUrl: "https://github.com/acme/infra.git",
    },
  ]);
});

test("github: a merged pull request is closed, like an abandoned one", () => {
  const events = githubRefEvents.parseEvents(
    githubSigned("pull_request", {
      action: "closed",
      number: 42,
      pull_request: {
        title: "Add the VNet",
        state: "closed",
        merged: true,
        head: { ref: "feature/vnet", sha: "beef22" },
      },
    }),
  );
  assert.equal(events[0]?.prState, "closed");
});

test("github: a ping and an event we do not track are silence, not errors", () => {
  assert.deepEqual(githubRefEvents.parseEvents(githubSigned("ping", { zen: "hi" })), []);
  assert.deepEqual(
    githubRefEvents.parseEvents(githubSigned("issue_comment", { action: "created" })),
    [],
  );
});

/* --- GitLab --------------------------------------------------------------- */

test("gitlab: the shared token in the header authenticates the delivery", () => {
  const delivery = hook({ "x-gitlab-token": SECRET, "x-gitlab-event": "Push Hook" }, {});
  assert.equal(gitlabRefEvents.verifySignature(delivery, SECRET), true);
  assert.equal(gitlabRefEvents.verifySignature(delivery, "nope"), false);
  assert.equal(gitlabRefEvents.verifySignature(hook({}, {}), SECRET), false);
});

test("gitlab: a push hook becomes a push event", () => {
  const events = gitlabRefEvents.parseEvents(
    hook(
      { "x-gitlab-event": "Push Hook" },
      {
        ref: "refs/heads/main",
        after: "aaa111",
        before: "000999",
        project: { git_http_url: "https://gitlab.com/acme/infra.git" },
      },
    ),
  );
  assert.deepEqual(events, [
    {
      kind: "push",
      branch: "main",
      sha: "aaa111",
      remoteUrl: "https://gitlab.com/acme/infra.git",
    },
  ]);
});

test("gitlab: a zero after-sha is a deleted branch", () => {
  const events = gitlabRefEvents.parseEvents(
    hook(
      { "x-gitlab-event": "Push Hook" },
      { ref: "refs/heads/gone", after: ZERO, before: "cafe01" },
    ),
  );
  assert.equal(events[0]?.kind, "branch_deleted");
  assert.equal(events[0]?.branch, "gone");
});

test("gitlab: a merge request hook uses the iid, which is what our URLs use", () => {
  const events = gitlabRefEvents.parseEvents(
    hook(
      { "x-gitlab-event": "Merge Request Hook" },
      {
        object_attributes: {
          iid: 7,
          title: "Add the subnet",
          state: "merged",
          source_branch: "feature/subnet",
          last_commit: { id: "beef33" },
        },
        project: { git_http_url: "https://gitlab.com/acme/infra.git" },
      },
    ),
  );
  assert.equal(events[0]?.prNumber, 7);
  assert.equal(events[0]?.prState, "closed", "merged is not open");
  assert.equal(events[0]?.branch, "feature/subnet");
});

/* --- Azure DevOps --------------------------------------------------------- */

test("azure devops: the shared token header authenticates the delivery", () => {
  const delivery = hook({ "x-groundplan-token": SECRET }, {});
  assert.equal(azureDevOpsRefEvents.verifySignature(delivery, SECRET), true);
  assert.equal(azureDevOpsRefEvents.verifySignature(delivery, "nope"), false);
});

test("azure devops: one push can update several refs, and each is an event", () => {
  const events = azureDevOpsRefEvents.parseEvents(
    hook(
      {},
      {
        eventType: "git.push",
        resource: {
          refUpdates: [
            { name: "refs/heads/main", oldObjectId: "old1", newObjectId: "new1" },
            { name: "refs/heads/gone", oldObjectId: "old2", newObjectId: ZERO },
            { name: "refs/tags/v1", oldObjectId: ZERO, newObjectId: "tag1" },
          ],
          repository: { remoteUrl: "https://dev.azure.com/acme/infra/_git/repo" },
        },
      },
    ),
  );
  assert.deepEqual(
    events.map((e) => [e.kind, e.branch]),
    [
      ["push", "main"],
      ["branch_deleted", "gone"],
    ],
    "the tag is not a branch event",
  );
});

test("azure devops: a completed pull request is closed", () => {
  const events = azureDevOpsRefEvents.parseEvents(
    hook(
      {},
      {
        eventType: "git.pullrequest.merged",
        resource: {
          pullRequestId: 15,
          title: "Add the NSG",
          status: "completed",
          sourceRefName: "refs/heads/feature/nsg",
          lastMergeSourceCommit: { commitId: "beef44" },
          repository: { remoteUrl: "https://dev.azure.com/acme/infra/_git/repo" },
        },
      },
    ),
  );
  assert.deepEqual(events, [
    {
      kind: "pull_request",
      branch: "feature/nsg",
      sha: "beef44",
      prNumber: 15,
      prTitle: "Add the NSG",
      prState: "closed",
      remoteUrl: "https://dev.azure.com/acme/infra/_git/repo",
    },
  ]);
});

test("every source treats an unreadable body as no events", () => {
  const garbage: RawWebhook = {
    headers: { "x-github-event": "push", "x-gitlab-event": "Push Hook" },
    rawBody: Buffer.from("not json"),
    json: null,
  };
  assert.deepEqual(githubRefEvents.parseEvents(garbage), []);
  assert.deepEqual(gitlabRefEvents.parseEvents(garbage), []);
  assert.deepEqual(azureDevOpsRefEvents.parseEvents(garbage), []);
});
