/**
 * GP-201: reading and writing the policy configuration.
 *
 * Two scopes, one shape: an organization's document, and a repository's override
 * of it. Both return the whole catalogue with the configuration each rule would
 * run under, because that — not the sparse document — is what a settings screen
 * has to draw and what a reader has to understand.
 *
 * Reading is `org:read` (a rule you are graded against must not be invisible to
 * you); writing is `policy:manage`, i.e. admin. Cross-tenant addresses are 404
 * before this file runs: the org-scope guard owns that.
 */
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";

import { repositories } from "../db/schema.js";
import { POLICY_SEVERITIES } from "../graph/policy/types.js";
import type { PolicyConfig } from "../graph/policy/types.js";
import { orgIdOf, requirePermission } from "../rbac/request.js";
import {
  catalogWithConfig,
  deleteRepositoryPolicyConfig,
  mergePolicyConfig,
  orgPolicyConfig,
  repositoryPolicyOverride,
  savePolicyConfig,
  validatePolicyConfig,
} from "../services/policy-config.js";
import {
  ensurePolicyReport,
  loadSnapshot,
  organizationRepositoryIds,
  reevaluateDocsPolicy,
  targetForSource,
} from "../services/policy.js";
import { docsSourceFor } from "../services/graph-snapshots.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

/** One rule's override. Every field optional: an override says only what it changes. */
const ruleOverrideSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    severity: { type: "string", enum: [...POLICY_SEVERITIES] },
    // v1 takes simple JSON parameters only — there is no rule DSL, and this is
    // deliberately not the place one would sneak in.
    params: { type: "object" },
  },
};

const configBodySchema = {
  type: "object",
  required: ["rules"],
  additionalProperties: false,
  properties: {
    rules: {
      type: "object",
      additionalProperties: ruleOverrideSchema,
      // A configuration is written whole; this caps how big "whole" can be.
      maxProperties: 200,
    },
  },
};

export const policyRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The policy verdict on one snapshot (GP-202/GP-203): the report, and — for a
   * pull request — how it compares with the documentation of main. Judged on
   * demand if it never was: the evaluation is deterministic, so producing it now
   * yields what producing it then would have.
   */
  app.get(
    "/snapshots/:id/policy",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const snapshot = await loadSnapshot(app.db, id);
      if (!snapshot) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "snapshot not found" });
      }
      const row = await ensurePolicyReport(app.db, snapshot);
      return {
        snapshotId: row.snapshotId,
        report: row.report,
        delta: row.delta,
        summaryMd: row.summaryMd,
      };
    },
  );

  /** The organization's configuration, as the whole catalogue. */
  app.get("/policy-config", async (request) => {
    const orgId = orgIdOf(request);
    const rules = await orgPolicyConfig(app.db, orgId);
    return {
      scope: "organization" as const,
      rules,
      catalog: catalogWithConfig(rules, rules),
    };
  });

  app.put(
    "/policy-config",
    { schema: { body: configBodySchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "policy:manage")) return;
      const orgId = orgIdOf(request);
      const { rules } = request.body as { rules: PolicyConfig };

      const invalid = validatePolicyConfig(rules);
      if (invalid) {
        return reply
          .code(422)
          .send({ error: "Unprocessable Entity", message: invalid });
      }

      await savePolicyConfig(
        app.db,
        { organizationId: orgId },
        rules,
        request.authUser?.id ?? null,
      );

      // A configuration change is a change to what the documentation of main
      // *says*, so main is re-judged — in the background, because an estate can
      // hold a lot of repositories and a settings toggle should not wait for it.
      const repositoryIds = await organizationRepositoryIds(app.db, orgId);
      app.runInBackground(reevaluateDocsPolicy(app.db, repositoryIds));

      return {
        scope: "organization" as const,
        rules,
        catalog: catalogWithConfig(rules, rules),
      };
    },
  );

  /**
   * A repository's view: what it inherits, what it overrides, and what it is
   * actually evaluated under. All three, because an override you cannot tell
   * apart from an inherited value is an override nobody will trust.
   */
  app.get(
    "/repositories/:id/policy-config",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const repo = await loadRepo(id);
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      return repositoryView(orgIdOf(request), id, repo.iacType);
    },
  );

  app.put(
    "/repositories/:id/policy-config",
    { schema: { params: idParamsSchema, body: configBodySchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "policy:manage")) return;
      const { id } = request.params as { id: string };
      const { rules } = request.body as { rules: PolicyConfig };

      const repo = await loadRepo(id);
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      const invalid = validatePolicyConfig(rules);
      if (invalid) {
        return reply
          .code(422)
          .send({ error: "Unprocessable Entity", message: invalid });
      }

      await savePolicyConfig(
        app.db,
        { organizationId: orgIdOf(request), repositoryId: id },
        rules,
        request.authUser?.id ?? null,
      );
      app.runInBackground(reevaluateDocsPolicy(app.db, [id]));

      return repositoryView(orgIdOf(request), id, repo.iacType);
    },
  );

  /** Remove the override: the repository goes back to the org's configuration. */
  app.delete(
    "/repositories/:id/policy-config",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "policy:manage")) return;
      const { id } = request.params as { id: string };
      const repo = await loadRepo(id);
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      await deleteRepositoryPolicyConfig(app.db, id);
      app.runInBackground(reevaluateDocsPolicy(app.db, [id]));
      return reply.code(204).send();
    },
  );

  async function loadRepo(id: string) {
    const [repo] = await app.db
      .select({ id: repositories.id, iacType: repositories.iacType })
      .from(repositories)
      .where(eq(repositories.id, id));
    return repo;
  }

  async function repositoryView(
    orgId: string,
    repositoryId: string,
    iacType: "terraform" | "kubernetes",
  ) {
    const [inherited, override] = await Promise.all([
      orgPolicyConfig(app.db, orgId),
      repositoryPolicyOverride(app.db, repositoryId),
    ]);
    const effective = override
      ? mergePolicyConfig(inherited, override)
      : inherited;
    return {
      scope: "repository" as const,
      inherited,
      // null (not {}) is the difference between "inherits" and "overrides
      // nothing on purpose" — the UI shows those two states differently.
      override,
      rules: effective,
      catalog: catalogWithConfig(
        effective,
        override ?? {},
        targetForSource(docsSourceFor(iacType)),
      ),
    };
  }
};
