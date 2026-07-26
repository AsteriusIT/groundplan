/**
 * Credential resolution (GP-192): the rule that decides what authenticates a
 * repository. The migration's promise — "existing PATs keep working" — is a
 * behaviour, so it is asserted here rather than trusted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { createEncryptor } from "../lib/encryption.js";
import type {
  IntegrationCredentialRow,
  RepositoryRow,
} from "../db/schema.js";
import {
  registerStrategy,
  repositoryAccessToken,
  resolveRepositoryCredential,
  staticStrategy,
} from "./credentials.js";
import { CredentialRevokedError } from "./types.js";

const encryptor = createEncryptor(
  Buffer.from("groundplan-test-encryption-key!!", "utf8").toString("base64"),
);

/** A minimal app: the DB always answers with `credentialRow`, or nothing. */
function fakeApp(credentialRow: IntegrationCredentialRow | null): FastifyInstance {
  const warnings: unknown[] = [];
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(credentialRow ? [credentialRow] : []),
        }),
      }),
    },
    encryptor,
    log: { warn: (obj: unknown) => warnings.push(obj) },
  } as unknown as FastifyInstance;
}

function repo(overrides: Partial<RepositoryRow> = {}): RepositoryRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    projectId: "22222222-2222-2222-2222-222222222222",
    provider: "github",
    iacType: "terraform",
    url: "https://github.com/acme/infra",
    defaultBranch: "main",
    accessToken: null,
    credentialId: null,
    connectionStatus: "unverified",
    verifiedAt: null,
    webhookToken: "wh",
    prCommentsEnabled: false,
    lastCommentError: null,
    contextMd: null,
    terraformPath: "",
    lastPolledAt: null,
    pollError: null,
    createdAt: new Date(0),
    ...overrides,
  } as RepositoryRow;
}

function credential(
  overrides: Partial<IntegrationCredentialRow> = {},
): IntegrationCredentialRow {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    organizationId: "44444444-4444-4444-4444-444444444444",
    provider: "github",
    mode: "installation_app",
    name: "acme",
    config: {},
    secret: null,
    status: "ok",
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as IntegrationCredentialRow;
}

test("a repository with only a PAT resolves to the pat strategy", async () => {
  const app = fakeApp(null);
  const row = repo({ accessToken: encryptor.encrypt("ghp_secret") });

  const credentialResult = await repositoryAccessToken(app, row);

  assert.deepEqual(credentialResult, { token: "ghp_secret", mode: "pat" });
});

test("a repository with neither a PAT nor a connection has no strategy", async () => {
  assert.equal(await resolveRepositoryCredential(fakeApp(null), repo()), null);
});

test("a PAT that will not decrypt is 'no credential', not a crash", async () => {
  const app = fakeApp(null);
  const row = repo({ accessToken: "not-ciphertext" });

  assert.equal(await resolveRepositoryCredential(app, row), null);
});

test("a connection wins over the repository's own PAT", async () => {
  registerStrategy("github", "installation_app", () =>
    staticStrategy("installation_app", "ghs_installation"),
  );
  const app = fakeApp(credential());
  const row = repo({
    accessToken: encryptor.encrypt("ghp_old_pat"),
    credentialId: credential().id,
  });

  assert.deepEqual(await repositoryAccessToken(app, row), {
    token: "ghs_installation",
    mode: "installation_app",
  });
});

test("a connection whose mode has no handler on this instance fails honestly", async () => {
  const app = fakeApp(credential({ provider: "gitlab", mode: "oauth2" }));
  const row = repo({ provider: "gitlab", credentialId: credential().id });

  const strategy = await resolveRepositoryCredential(app, row);
  assert.ok(strategy);
  await assert.rejects(
    () => strategy.getToken(),
    (err: unknown) =>
      err instanceof CredentialRevokedError && /no oauth2 handler/.test(err.message),
  );
});

test("a dangling credential id falls back to the PAT rather than failing", async () => {
  // The FK is `set null` on delete, so this is only reachable as a race — and a
  // repository that still has a PAT should keep working through it.
  const app = fakeApp(null);
  const row = repo({
    credentialId: credential().id,
    accessToken: encryptor.encrypt("ghp_fallback"),
  });

  assert.deepEqual(await repositoryAccessToken(app, row), {
    token: "ghp_fallback",
    mode: "pat",
  });
});
