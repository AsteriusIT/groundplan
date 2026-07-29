/**
 * Resolving how a repository will authenticate — once, for creation *and* for
 * update (GP-229).
 *
 * The bug this fixes is an asymmetry: an installation could be chosen when
 * editing a repository but not when attaching one, so the only way to attach a
 * repository covered by a GitHub App was to create it broken and then repair
 * it. Two handlers with two ideas of what a credential is will drift again the
 * moment a fourth mode appears, so there is one resolver and both call it.
 *
 * The order is deliberate and short:
 *
 *   1. an explicit `installationId` — the user pointed at an installation;
 *   2. an explicit `credentialId`   — the user pointed at a connection;
 *   3. resolution by owner          — exactly one of this org's installations
 *      covers this repository's owner, so there is nothing to ask;
 *   4. a PAT                        — supplied now, or already stored;
 *   5. nothing, and we say so.
 *
 * Step 3 is what makes the import of GP-230 possible without a token per row.
 * It is deliberately conservative: *exactly one* candidate, or we refuse and
 * let a human choose. Guessing between two GitHub organizations would attach a
 * repository under the wrong account's credential and look like it worked.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";

import {
  integrationCredentials,
  projects,
  type IntegrationCredentialRow,
  type RepositoryRow,
} from "../db/schema.js";
import { strategyForCredential, staticStrategy } from "../integrations/credentials.js";
import {
  CredentialRevokedError,
  type CredentialStrategy,
  type ProviderId,
} from "../integrations/types.js";
import { parseOwnerRepo } from "../lib/repo-url.js";

/**
 * Why a repository could not be attached. Each maps to one sentence and one
 * remediation in the form (GP-231) — "could not attach the repository" is the
 * message this epic exists to delete.
 */
export const ATTACH_ERROR_CODES = [
  "no_credential_resolved",
  "installation_does_not_cover_repo",
  "insufficient_permissions",
  "unreachable",
] as const;
export type AttachErrorCode = (typeof ATTACH_ERROR_CODES)[number];

export class AttachError extends Error {
  readonly code: AttachErrorCode;
  constructor(code: AttachErrorCode, message: string) {
    super(message);
    this.name = "AttachError";
    this.code = code;
  }
}

/**
 * The one rendering of an attach refusal: 422 with the code the form switches
 * its remediation on. Nothing is broken on our side — the answer is one the
 * user has to act on, and it is never a generic "could not attach".
 */
export function attachFailure(reply: FastifyReply, error: AttachError) {
  return reply.code(422).send({
    error: "Unprocessable Entity",
    message: error.message,
    code: error.code,
    fields: [],
  });
}

/** What the caller asked for, in whichever form it had. */
export type CredentialRequest = {
  /** A GitHub App installation id, as the connect flow stored it. */
  installationId?: number;
  /** An org connection's id. */
  credentialId?: string | null;
  /** A PAT supplied in this request (plaintext). */
  accessToken?: string;
};

/** What a repository row needs in order to be written. */
export type ResolvedCredential = {
  /** The org connection to point at, or null for the PAT column. */
  credentialId: string | null;
  /** Ciphertext to store, undefined to leave the column untouched. */
  encryptedPat?: string | null;
  /** How the resolved credential authenticates, for the verify call. */
  strategy: CredentialStrategy | null;
};

/** Every connection this org holds for one provider. */
async function connectionsFor(
  app: FastifyInstance,
  orgId: string,
  provider: ProviderId,
): Promise<IntegrationCredentialRow[]> {
  return app.db
    .select()
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.organizationId, orgId),
        eq(integrationCredentials.provider, provider),
      ),
    );
}

/**
 * Does this connection cover this repository?
 *
 * A connection is bound to one of two things, and it says which by what it
 * stores — so this reads the connection rather than naming providers:
 *
 *  - **Account-bound** (`account`, no instance): a GitHub App installation, tied
 *    to the org or user the app was installed on. It covers repositories whose
 *    owner *is* that account. Logins are case-insensitive, so the owner is
 *    compared case-insensitively — but `acme/infra` and `acme/Infra` are two
 *    different repositories, so nothing else is folded.
 *  - **Instance-bound** (`instanceUrl`): a GitLab or Entra OAuth connection. It
 *    is a *user's* authorization on an instance, and that user may well belong
 *    to namespaces they do not own — `helix-saas/infra` reached by an account
 *    called `tintin92350` is the normal case, not the exception. So it covers
 *    the instance it names, and whether it can truly read a given project is
 *    settled by the reachability check we run before persisting anything.
 *
 * Getting this wrong was a real bug: the account rule alone refused every
 * GitLab project outside the authorizing user's own namespace.
 */
export function connectionCoversUrl(
  connection: IntegrationCredentialRow,
  url: string,
): boolean {
  const { account, instanceUrl } = connection.config;

  if (instanceUrl && sameHost(instanceUrl, url)) return true;

  if (!account) return false;
  const parsed = parseOwnerRepo(url);
  if (!parsed) return false;
  return parsed.owner === account.toLowerCase();
}

/** Do these two URLs live on the same host? */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Resolve the credential a repository will use, or throw a typed refusal.
 *
 * `existing` is the row being updated, absent when attaching: it is what makes
 * "keep the PAT you already have" work on a PATCH that says nothing about
 * credentials.
 */
export async function resolveCredentialFor(
  app: FastifyInstance,
  args: {
    orgId: string;
    provider: ProviderId;
    url: string;
    request: CredentialRequest;
    existing?: RepositoryRow;
  },
): Promise<ResolvedCredential> {
  const { request, existing } = args;
  const connections = await connectionsFor(app, args.orgId, args.provider);

  const pickConnection = (): IntegrationCredentialRow | null => {
    if (request.installationId !== undefined) {
      const byInstallation = connections.find(
        (row) => row.config.installationId === request.installationId,
      );
      if (!byInstallation) {
        throw new AttachError(
          "no_credential_resolved",
          "no connection in this organization matches that installation",
        );
      }
      if (!connectionCoversUrl(byInstallation, args.url)) {
        throw new AttachError(
          "installation_does_not_cover_repo",
          `the ${byInstallation.name} installation does not cover this repository — install the app on its owner, or attach it with a token`,
        );
      }
      return byInstallation;
    }

    if (request.credentialId) {
      const chosen = connections.find((row) => row.id === request.credentialId);
      if (!chosen) {
        throw new AttachError(
          "no_credential_resolved",
          "that connection does not exist in this organization",
        );
      }
      return chosen;
    }
    // An explicit null is "go back to the PAT", not "resolve something for me".
    if (request.credentialId === null) return null;

    // Nothing explicit: an installation covering this owner, if exactly one
    // does. Two candidates is a question, not a coin toss.
    const covering = connections.filter((row) => connectionCoversUrl(row, args.url));
    return covering.length === 1 ? covering[0]! : null;
  };

  const connection = pickConnection();
  if (connection) {
    return {
      credentialId: connection.id,
      // A repository moving onto a connection keeps its PAT column untouched,
      // so the move stays reversible (GP-192).
      ...(request.accessToken !== undefined
        ? { encryptedPat: app.encryptor.encrypt(request.accessToken) }
        : {}),
      strategy: strategyForCredential(app, connection),
    };
  }

  if (request.accessToken !== undefined) {
    return {
      credentialId: null,
      encryptedPat: app.encryptor.encrypt(request.accessToken),
      strategy: staticStrategy("pat", request.accessToken),
    };
  }

  // Nothing new was offered — keep whatever the row already authenticates with.
  if (existing) {
    return {
      credentialId: request.credentialId === null ? null : existing.credentialId,
      strategy: await existingStrategy(app, existing, request),
    };
  }

  // A brand-new repository with no credential at all: legitimate for a public
  // repository, so this is not an error — the reachability check decides.
  return { credentialId: null, encryptedPat: null, strategy: null };
}

/** The strategy a row already had, honouring an explicit switch back to PAT. */
async function existingStrategy(
  app: FastifyInstance,
  existing: RepositoryRow,
  request: CredentialRequest,
): Promise<CredentialStrategy | null> {
  if (request.credentialId !== null && existing.credentialId) {
    const [row] = await app.db
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.id, existing.credentialId));
    if (row) return strategyForCredential(app, row);
  }
  if (!existing.accessToken) return null;
  try {
    return staticStrategy("pat", app.encryptor.decrypt(existing.accessToken));
  } catch {
    return null;
  }
}

/**
 * Prove the repository is reachable with the credential we resolved, *before*
 * anything is written. A repository created in a state it cannot be cloned from
 * is a repository whose every later feature fails quietly; refusing at the door
 * is the whole point.
 */
export async function assertReachable(
  app: FastifyInstance,
  args: {
    url: string;
    provider: ProviderId;
    ref: string;
    strategy: CredentialStrategy | null;
  },
): Promise<void> {
  let token: string | null = null;
  let mode;
  if (args.strategy) {
    try {
      ({ token } = await args.strategy.getToken());
      mode = args.strategy.mode;
    } catch (err) {
      if (err instanceof CredentialRevokedError) {
        throw new AttachError("insufficient_permissions", err.message);
      }
      throw err;
    }
  }

  const result = await app.verifyConnection({
    url: args.url,
    provider: args.provider,
    ref: args.ref,
    accessToken: token,
    credentialMode: mode,
  });
  if (result.ok) return;

  // The user gets the classification; the operator gets the reason. Without
  // this line "the repository could not be reached" is where the investigation
  // both starts and ends.
  app.log.warn(
    {
      url: args.url,
      provider: args.provider,
      error: result.error,
      detail: result.detail,
      authenticated: token !== null,
    },
    "repository verification failed",
  );

  if (result.error === "auth_failed") {
    throw new AttachError(
      "insufficient_permissions",
      args.strategy
        ? "the credential was refused by the provider — check it grants read access to this repository"
        : "this repository is private: attach it through an installation, or supply a token",
    );
  }
  if (result.error === "not_found") {
    throw new AttachError(
      args.strategy ? "installation_does_not_cover_repo" : "no_credential_resolved",
      args.strategy
        ? "the credential cannot see this repository — check the URL, and that the installation covers it"
        : "this repository could not be read anonymously — check the URL, or attach it with a credential",
    );
  }
  throw new AttachError(
    "unreachable",
    "the repository could not be reached — check the URL and that the host is available from this deployment",
  );
}

/**
 * The credential half of a request body, whichever handler received it. One
 * reader for one shared schema: a field the create path forgot to forward is
 * exactly the class of bug this story exists to remove.
 */
export function credentialRequestFrom(body: {
  accessToken?: string;
  credentialId?: string | null;
  installationId?: number;
}): CredentialRequest {
  return {
    ...(body.accessToken !== undefined ? { accessToken: body.accessToken } : {}),
    ...(body.credentialId !== undefined ? { credentialId: body.credentialId } : {}),
    ...(body.installationId !== undefined
      ? { installationId: body.installationId }
      : {}),
  };
}

/**
 * Resolve a credential and prove the repository is reachable with it, as one
 * step, reporting a refusal rather than throwing it. Both handlers and the bulk
 * import call this — which is what the shared contract suite pins.
 */
export async function prepareCredential(
  app: FastifyInstance,
  args: {
    orgId: string;
    provider: ProviderId;
    url: string;
    ref: string;
    request: CredentialRequest;
    existing?: RepositoryRow;
  },
): Promise<{ ok: true; resolved: ResolvedCredential } | { ok: false; error: AttachError }> {
  try {
    const resolved = await resolveCredentialFor(app, {
      orgId: args.orgId,
      provider: args.provider,
      url: args.url,
      request: args.request,
      ...(args.existing ? { existing: args.existing } : {}),
    });
    await assertReachable(app, {
      url: args.url,
      provider: args.provider,
      ref: args.ref,
      strategy: resolved.strategy,
    });
    return { ok: true, resolved };
  } catch (err) {
    if (err instanceof AttachError) return { ok: false, error: err };
    throw err;
  }
}

/** Does this project belong to this org? (Import addresses a project by id.) */
export async function projectInOrg(
  app: FastifyInstance,
  orgId: string,
  projectId: string,
): Promise<boolean> {
  const [row] = await app.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)));
  return row !== undefined;
}
