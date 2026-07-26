/**
 * The GitHub App credential (GP-193). Everything here runs offline: a throwaway
 * RSA keypair signs the app JWT, and the app client is a stub — the point is the
 * *rules* (short-lived tokens, renewal before expiry, honest degradation on
 * revocation), not GitHub's HTTP.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";

import type { GitHubAppConfig } from "../config.js";
import { CredentialRevokedError } from "../types.js";
import {
  clearInstallationTokenCache,
  githubAppConnectFlow,
  GitHubAppError,
  installationToken,
  signAppJwt,
  type GitHubAppClient,
} from "./github-app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const config: GitHubAppConfig = {
  appId: "12345",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  slug: "groundplan",
  webhookSecret: "",
};

const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);

/** A stub app client whose token minting is scripted. */
function stubClient(
  script: {
    token?: string;
    expiresInMs?: number;
    fail?: GitHubAppError;
    account?: string | null;
  } = {},
): GitHubAppClient & { tokenCalls: number } {
  const stub = {
    tokenCalls: 0,
    getInstallation: async (installationId: number) => ({
      id: installationId,
      account: script.account ?? "acme-corp",
    }),
    createInstallationToken: async () => {
      stub.tokenCalls += 1;
      if (script.fail) throw script.fail;
      return {
        token: script.token ?? "ghs_installation_token",
        expiresAt: new Date(NOW + (script.expiresInMs ?? 3_600_000)),
      };
    },
  };
  return stub;
}

test("the app JWT is signed by the app's private key and names the app", () => {
  const jwt = signAppJwt(config, NOW);
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header && payload && signature);

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.ok(
    verifier.verify(publicKey, signature!, "base64url"),
    "the signature verifies against the app's public key",
  );

  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  assert.equal(claims.iss, "12345");
  assert.ok(claims.iat < Math.floor(NOW / 1000), "iat is backdated for clock skew");
  assert.ok(
    claims.exp - claims.iat <= 600,
    "GitHub rejects an app JWT living longer than ten minutes",
  );
});

test("an installation token is minted once and reused until it nears expiry", async () => {
  clearInstallationTokenCache();
  const client = stubClient({ expiresInMs: 3_600_000 });

  const first = await installationToken(config, client, 42, NOW);
  const second = await installationToken(config, client, 42, NOW + 60_000);

  assert.equal(first.token, "ghs_installation_token");
  assert.equal(second.token, first.token);
  assert.equal(client.tokenCalls, 1, "the cached token is reused");
  assert.ok(first.expiresAt, "a short-lived token knows when it dies");
});

test("a token inside the renewal margin is replaced, never handed out stale", async () => {
  clearInstallationTokenCache();
  const client = stubClient({ expiresInMs: 3_600_000 });

  await installationToken(config, client, 42, NOW);
  // 30s before expiry: inside the 60s margin, so it must be re-minted.
  await installationToken(config, client, 42, NOW + 3_600_000 - 30_000);

  assert.equal(client.tokenCalls, 2);
});

test("tokens are scoped per installation, never shared", async () => {
  clearInstallationTokenCache();
  const client = stubClient();

  await installationToken(config, client, 42, NOW);
  await installationToken(config, client, 43, NOW);

  assert.equal(client.tokenCalls, 2, "one installation's token is not another's");
});

test("a revoked installation asks for reconnection instead of retrying forever", async () => {
  clearInstallationTokenCache();
  const client = stubClient({
    fail: new GitHubAppError(404, "GitHub App API 404: Not Found"),
  });

  await assert.rejects(
    () => installationToken(config, client, 42, NOW),
    (err: unknown) => err instanceof CredentialRevokedError,
  );
});

test("a transient GitHub failure is not mistaken for a revocation", async () => {
  clearInstallationTokenCache();
  const client = stubClient({
    fail: new GitHubAppError(500, "GitHub App API 500: Server Error"),
  });

  await assert.rejects(
    () => installationToken(config, client, 42, NOW),
    (err: unknown) => err instanceof GitHubAppError && !(err instanceof CredentialRevokedError),
  );
});

test("the install flow sends the browser to the app's installation page", () => {
  const flow = githubAppConnectFlow(config, stubClient());
  const started = flow.start({ redirectUri: "https://gp.example.com/integrations/callback" });
  const url = new URL(started.authorizeUrl("sealed-state"));

  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/apps/groundplan/installations/new");
  assert.equal(url.searchParams.get("state"), "sealed-state");
  assert.deepEqual(started.carry, {}, "an App install has no PKCE verifier to keep");
});

test("completing an install stores the installation, and no secret at all", async () => {
  const flow = githubAppConnectFlow(config, stubClient({ account: "acme-corp" }));

  const connection = await flow.complete({
    params: { installation_id: "42" },
    carry: {},
    redirectUri: "https://gp.example.com/integrations/callback",
  });

  assert.equal(connection.name, "acme-corp");
  assert.equal(connection.config.installationId, 42);
  assert.equal(
    connection.secret,
    null,
    "nothing long-lived is stored — the app's private key is the only secret",
  );
});

test("a callback without an installation id is refused, not stored", async () => {
  const flow = githubAppConnectFlow(config, stubClient());

  await assert.rejects(
    () =>
      flow.complete({
        params: {},
        carry: {},
        redirectUri: "https://gp.example.com/integrations/callback",
      }),
    /installation id/,
  );
});
