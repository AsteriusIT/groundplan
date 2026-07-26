/**
 * Webhook parsing and verification, one implementation per provider (GP-194).
 *
 * Kept in one file rather than three because the three are ninety percent the
 * same shape and reading them side by side is how you notice when one drifts.
 * Each is a `RefEventSource`: verify the sender, then normalize whatever it sent
 * into the events the rest of the app already reacts to. A payload we do not
 * recognise (a ping, a tag push, a comment) normalizes to `[]` — silence, not
 * an error: providers send far more than we asked for.
 *
 * Verification is constant-time in every case, and always over the **raw
 * bytes**: re-serializing JSON changes them, which is why the route keeps the
 * buffer.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { RawWebhook, RefEvent, RefEventSource } from "./types.js";

const HEADS = "refs/heads/";
/** The sha GitLab (and git) uses for "this ref does not exist". */
const ZERO_SHA = "0000000000000000000000000000000000000000";

function header(hook: RawWebhook, name: string): string | undefined {
  return hook.headers[name.toLowerCase()];
}

/** Constant-time compare of two strings, safe on length mismatch. */
function safeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Short branch name from a `refs/heads/...` ref, or null for anything else. */
function branchOf(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.startsWith(HEADS)) return null;
  const branch = ref.slice(HEADS.length);
  return branch === "" ? null : branch;
}

/* -------------------------------------------------------------------------- */
/* GitHub                                                                     */
/* -------------------------------------------------------------------------- */

type GitHubPush = {
  ref?: string;
  after?: string;
  before?: string;
  deleted?: boolean;
  repository?: { clone_url?: string; html_url?: string };
};

type GitHubPullRequest = {
  action?: string;
  number?: number;
  pull_request?: {
    title?: string;
    state?: string;
    merged?: boolean;
    head?: { ref?: string; sha?: string };
  };
  repository?: { clone_url?: string; html_url?: string };
};

function githubRemote(body: {
  repository?: { clone_url?: string; html_url?: string };
}): string | null {
  return body.repository?.clone_url ?? body.repository?.html_url ?? null;
}

/**
 * GitHub signs each delivery with HMAC-SHA256 over the raw body, using the
 * secret configured on the App. One secret for every installation, which is why
 * this one can be checked *before* the payload is parsed.
 */
export const githubRefEvents: RefEventSource = {
  verifySignature(hook, secret) {
    const signature = header(hook, "x-hub-signature-256");
    if (!signature || !secret) return false;
    const expected = `sha256=${createHmac("sha256", secret).update(hook.rawBody).digest("hex")}`;
    return safeCompare(signature, expected);
  },

  parseEvents(hook) {
    const event = header(hook, "x-github-event");
    const body = hook.json as GitHubPush & GitHubPullRequest;
    if (!body || typeof body !== "object") return [];

    if (event === "push") {
      const branch = branchOf(body.ref);
      if (!branch) return []; // a tag, or a ref namespace we do not track
      const remoteUrl = githubRemote(body);
      if (body.deleted || body.after === ZERO_SHA) {
        return [
          {
            kind: "branch_deleted",
            branch,
            sha: body.before ?? ZERO_SHA,
            remoteUrl,
          },
        ];
      }
      return [{ kind: "push", branch, sha: body.after ?? "", remoteUrl }];
    }

    if (event === "delete") {
      const raw = hook.json as { ref?: string; ref_type?: string };
      if (raw.ref_type !== "branch" || typeof raw.ref !== "string") return [];
      return [
        {
          kind: "branch_deleted",
          branch: raw.ref,
          sha: ZERO_SHA,
          remoteUrl: githubRemote(body),
        },
      ];
    }

    if (event === "pull_request") {
      const pr = body.pull_request;
      const number = body.number;
      if (!pr || typeof number !== "number") return [];
      // `closed` covers merged and abandoned alike: both mean "not open".
      const closed = body.action === "closed" || pr.state === "closed";
      return [
        {
          kind: "pull_request",
          branch: pr.head?.ref ?? "",
          sha: pr.head?.sha ?? "",
          prNumber: number,
          prTitle: pr.title,
          prState: closed ? "closed" : "open",
          remoteUrl: githubRemote(body),
        },
      ];
    }

    return [];
  },
};

/* -------------------------------------------------------------------------- */
/* GitLab                                                                     */
/* -------------------------------------------------------------------------- */

type GitLabPush = {
  ref?: string;
  after?: string;
  before?: string;
  project?: { git_http_url?: string; web_url?: string };
};

type GitLabMergeRequest = {
  object_attributes?: {
    iid?: number;
    title?: string;
    state?: string;
    action?: string;
    source_branch?: string;
    last_commit?: { id?: string };
  };
  project?: { git_http_url?: string; web_url?: string };
};

function gitlabRemote(body: {
  project?: { git_http_url?: string; web_url?: string };
}): string | null {
  return body.project?.git_http_url ?? body.project?.web_url ?? null;
}

/**
 * GitLab sends a shared secret in a header rather than a signature, so there is
 * nothing to compute — but the comparison is still constant-time, because a
 * timing oracle on a per-repository secret is a per-repository secret.
 */
export const gitlabRefEvents: RefEventSource = {
  verifySignature(hook, secret) {
    const token = header(hook, "x-gitlab-token");
    if (!token || !secret) return false;
    return safeCompare(token, secret);
  },

  parseEvents(hook) {
    const kind = header(hook, "x-gitlab-event");
    const body = hook.json as GitLabPush & GitLabMergeRequest;
    if (!body || typeof body !== "object") return [];

    if (kind === "Push Hook") {
      const branch = branchOf(body.ref);
      if (!branch) return [];
      const remoteUrl = gitlabRemote(body);
      if (body.after === ZERO_SHA) {
        return [
          { kind: "branch_deleted", branch, sha: body.before ?? ZERO_SHA, remoteUrl },
        ];
      }
      return [{ kind: "push", branch, sha: body.after ?? "", remoteUrl }];
    }

    if (kind === "Merge Request Hook") {
      const mr = body.object_attributes;
      if (!mr || typeof mr.iid !== "number") return [];
      const closed = mr.state === "closed" || mr.state === "merged";
      return [
        {
          kind: "pull_request",
          branch: mr.source_branch ?? "",
          sha: mr.last_commit?.id ?? "",
          prNumber: mr.iid,
          prTitle: mr.title,
          prState: closed ? "closed" : "open",
          remoteUrl: gitlabRemote(body),
        },
      ];
    }

    return [];
  },
};

/* -------------------------------------------------------------------------- */
/* Azure DevOps                                                               */
/* -------------------------------------------------------------------------- */

type AdoResource = {
  refUpdates?: { name?: string; oldObjectId?: string; newObjectId?: string }[];
  repository?: { remoteUrl?: string; webUrl?: string };
  pullRequestId?: number;
  title?: string;
  status?: string;
  sourceRefName?: string;
  lastMergeSourceCommit?: { commitId?: string };
};

type AdoPayload = { eventType?: string; resource?: AdoResource };

function adoRemote(resource: AdoResource | undefined): string | null {
  return resource?.repository?.remoteUrl ?? resource?.repository?.webUrl ?? null;
}

/**
 * Azure DevOps service hooks carry no signature, so the secret travels in the
 * same header the CI ingestion endpoint already uses — one convention for the
 * whole product rather than a second one to remember.
 */
export const azureDevOpsRefEvents: RefEventSource = {
  verifySignature(hook, secret) {
    const token = header(hook, "x-groundplan-token");
    if (!token || !secret) return false;
    return safeCompare(token, secret);
  },

  parseEvents(hook) {
    const body = hook.json as AdoPayload;
    if (!body || typeof body !== "object") return [];
    const resource = body.resource;
    const remoteUrl = adoRemote(resource);

    if (body.eventType === "git.push") {
      const events: RefEvent[] = [];
      for (const update of resource?.refUpdates ?? []) {
        const branch = branchOf(update.name);
        if (!branch) continue;
        if (update.newObjectId === ZERO_SHA) {
          events.push({
            kind: "branch_deleted",
            branch,
            sha: update.oldObjectId ?? ZERO_SHA,
            remoteUrl,
          });
        } else {
          events.push({
            kind: "push",
            branch,
            sha: update.newObjectId ?? "",
            remoteUrl,
          });
        }
      }
      return events;
    }

    if (body.eventType?.startsWith("git.pullrequest")) {
      if (typeof resource?.pullRequestId !== "number") return [];
      const status = resource.status;
      const closed = status === "completed" || status === "abandoned";
      return [
        {
          kind: "pull_request",
          branch: branchOf(resource.sourceRefName) ?? "",
          sha: resource.lastMergeSourceCommit?.commitId ?? "",
          prNumber: resource.pullRequestId,
          prTitle: resource.title,
          prState: closed ? "closed" : "open",
          remoteUrl,
        },
      ];
    }

    return [];
  },
};
