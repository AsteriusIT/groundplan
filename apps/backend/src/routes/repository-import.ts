/**
 * Bulk import (GP-229) — attaching what discovery found, in one request.
 *
 * Three decisions shape this route:
 *
 * **Partial success is the contract, not a failure mode.** Importing forty
 * repositories and losing thirty-nine because one had no credential would be
 * absurd. Each item is attempted on its own and the response says exactly what
 * happened to each: `imported`, `skipped`, `failed` — with 207, so a client
 * cannot mistake "mostly worked" for "worked".
 *
 * **A duplicate is `skipped`, not an error.** The identity of an attachment is
 * `(org, normalized url, kind, path)`. Re-importing the same row is a no-op
 * worth reporting quietly; the *same repository* with another kind or another
 * path is a legitimate second attachment — that is the monorepo GP-100
 * prescribes, and refusing it would be refusing the documented workflow.
 *
 * **`kind` is required per item.** It is immutable after attachment, so it is
 * never defaulted here: detection (GP-228) pre-selects it in the UI and a human
 * confirms it. A schema that accepted "both" would be a schema promising
 * something the product does not have.
 */
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";

import {
  projects,
  repositories,
  repositoryIacType,
  toPublicRepository,
} from "../db/schema.js";
import { InvalidRepoPathError, normalizeTerraformPath } from "../lib/repo-path.js";
import { repoUrlKey } from "../lib/repo-url.js";
import { generateToken } from "../lib/tokens.js";
import { orgIdOf, requirePermission } from "../rbac/request.js";
import { detectProvider, type Provider } from "../services/providers.js";
import { invalidateDiscoveryCache } from "../services/repo-discovery.js";
import {
  credentialRequestFrom,
  prepareCredential,
  projectInOrg,
} from "../services/repository-credential-resolution.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/**
 * A ceiling on one request. ADR #7: the import is synchronous and bounded — no
 * queue, no job — so the bound is stated rather than discovered by a timeout.
 */
const MAX_ITEMS = 50;

const importSchema = {
  type: "object",
  required: ["projectId", "items"],
  additionalProperties: false,
  properties: {
    /** Repositories live in projects; the import screen asks which one. */
    projectId: { type: "string", pattern: UUID_PATTERN },
    /** One connection for the whole batch, when the org holds several. */
    credentialId: { type: "string", pattern: UUID_PATTERN },
    installationId: { type: "integer", minimum: 1 },
    items: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        required: ["kind"],
        additionalProperties: false,
        properties: {
          /** `owner/name` as discovery reported it, or a full clone URL. */
          fullName: { type: "string", minLength: 1, maxLength: 400 },
          cloneUrl: { type: "string", minLength: 1, maxLength: 500 },
          /**
           * Required, and only ever one of the two: the kind is immutable
           * after attachment, so there is no "both" to accept here.
           */
          kind: { type: "string", enum: [...repositoryIacType.enumValues] },
          path: { type: "string", maxLength: 500 },
          defaultBranch: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
  },
};

type ImportItem = {
  fullName?: string;
  cloneUrl?: string;
  kind: (typeof repositoryIacType.enumValues)[number];
  path?: string;
  defaultBranch?: string;
};

/** The https clone URL for an item, from whichever form the caller sent. */
function urlFor(item: ImportItem, provider: Provider | null): string | null {
  if (item.cloneUrl) return item.cloneUrl.trim();
  if (!item.fullName) return null;
  const fullName = item.fullName.trim().replace(/^\/+/, "");
  if (!fullName.includes("/")) return null;
  // A bare `owner/name` is only meaningful for a provider with one known host;
  // anything else must send a URL rather than have one invented for it.
  return provider === "github" ? `https://github.com/${fullName}` : null;
}

export const repositoryImportRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/repositories/import",
    { schema: { body: importSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "project:manage")) return reply;
      const body = request.body as {
        projectId: string;
        credentialId?: string;
        installationId?: number;
        items: ImportItem[];
      };
      const orgId = orgIdOf(request);

      if (!(await projectInOrg(app, orgId, body.projectId))) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "project not found" });
      }

      // One read of what this org already has: the idempotence key is
      // `(org, normalized url, kind, path)`, and asking per item would be one
      // query per row for an answer that cannot change mid-request.
      const existing = await existingKeys(orgId);

      const imported: unknown[] = [];
      const skipped: { item: ImportItem; reason: string }[] = [];
      const failed: { item: ImportItem; error: string; code: string }[] = [];

      for (const item of body.items) {
        const outcome = await importOne(item, body, orgId, existing);
        if (outcome.kind === "imported") imported.push(outcome.repository);
        else if (outcome.kind === "skipped") {
          skipped.push({ item, reason: outcome.reason });
        } else failed.push({ item, error: outcome.error, code: outcome.code });
      }

      if (imported.length > 0) {
        // The badges in the import screen would otherwise lie for a minute.
        invalidateDiscoveryCache(orgId);
      }

      // 207: some of this may not have worked, and the caller must look.
      return reply.code(207).send({ imported, skipped, failed });
    },
  );

  /** Every `(url, kind, path)` this org already attaches, as comparison keys. */
  async function existingKeys(orgId: string): Promise<Set<string>> {
    const rows = await app.db
      .select({
        url: repositories.url,
        kind: repositories.iacType,
        path: repositories.terraformPath,
      })
      .from(repositories)
      .innerJoin(projects, eq(repositories.projectId, projects.id))
      .where(eq(projects.organizationId, orgId));
    return new Set(
      rows.map((row) => attachmentKey(row.url, row.kind, row.path)),
    );
  }

  async function importOne(
    item: ImportItem,
    body: { projectId: string; credentialId?: string; installationId?: number },
    orgId: string,
    existing: Set<string>,
  ): Promise<
    | { kind: "imported"; repository: unknown }
    | { kind: "skipped"; reason: string }
    | { kind: "failed"; error: string; code: string }
  > {
    const provider = item.cloneUrl ? detectProvider(item.cloneUrl) : "github";
    const url = urlFor(item, provider);
    if (!url) {
      return {
        kind: "failed",
        code: "invalid_item",
        error: "send a clone URL, or an owner/name for a provider with a known host",
      };
    }

    let path: string;
    try {
      path = normalizeTerraformPath(item.path);
    } catch (err) {
      if (err instanceof InvalidRepoPathError) {
        return { kind: "failed", code: "invalid_item", error: err.message };
      }
      throw err;
    }

    // The same repository with another kind or another path is a *different*
    // attachment — the monorepo — so only an exact triple is a duplicate.
    const key = attachmentKey(url, item.kind, path);
    if (existing.has(key)) {
      return { kind: "skipped", reason: "already attached with this type and path" };
    }

    const defaultBranch = item.defaultBranch ?? "main";
    const resolvedProvider = item.cloneUrl ? provider : detectProvider(url);
    const prepared = await prepareCredential(app, {
      orgId,
      provider: resolvedProvider,
      url,
      ref: defaultBranch,
      request: credentialRequestFrom(body),
    });
    if (!prepared.ok) {
      return {
        kind: "failed",
        code: prepared.error.code,
        error: prepared.error.message,
      };
    }

    const [inserted] = await app.db
      .insert(repositories)
      .values({
        projectId: body.projectId,
        provider: resolvedProvider,
        iacType: item.kind,
        url,
        defaultBranch,
        accessToken: prepared.resolved.encryptedPat ?? null,
        credentialId: prepared.resolved.credentialId,
        terraformPath: path,
        webhookToken: generateToken(),
        connectionStatus: "ok",
        verifiedAt: new Date(),
      })
      .returning();

    // Within one request too: two identical items must not both be created.
    existing.add(key);
    return {
      kind: "imported",
      repository: {
        ...toPublicRepository(inserted!),
        webhookToken: inserted!.webhookToken,
      },
    };
  }
};

/** `(url, kind, path)` — an attachment's identity within an organization. */
function attachmentKey(url: string, kind: string, path: string): string {
  return `${repoUrlKey(url)}|${kind}|${path}`;
}
