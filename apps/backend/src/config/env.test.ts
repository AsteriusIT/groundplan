import { test } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "./env.js";

/** Run `fn` with the given env vars applied, then restore the previous values. */
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("development defaults OIDC to the dockerized Keycloak (auth enabled)", () => {
  withEnv(
    { NODE_ENV: "development", OIDC_ISSUER_URL: undefined, OIDC_AUDIENCE: undefined },
    () => {
      const env = loadEnv();
      assert.ok(env.oidcIssuer.length > 0, "issuer should default in dev");
      assert.ok(env.oidcAudience.length > 0, "audience should default in dev");
    },
  );
});

test("test env leaves OIDC unset so existing route tests run unauthenticated", () => {
  withEnv({ NODE_ENV: "test", OIDC_ISSUER_URL: undefined, OIDC_AUDIENCE: undefined }, () => {
    assert.equal(loadEnv().oidcIssuer, "");
    assert.equal(loadEnv().oidcAudience, "");
  });
});

test("production leaves OIDC unset (fail-closed: startup requires explicit config)", () => {
  withEnv(
    { NODE_ENV: "production", OIDC_ISSUER_URL: undefined, OIDC_AUDIENCE: undefined },
    () => {
      assert.equal(loadEnv().oidcIssuer, "");
    },
  );
});

test("an explicit empty OIDC_ISSUER_URL disables auth even in dev", () => {
  withEnv({ NODE_ENV: "development", OIDC_ISSUER_URL: "" }, () => {
    assert.equal(loadEnv().oidcIssuer, "");
  });
});

test("an explicit OIDC_ISSUER_URL is always respected", () => {
  withEnv({ NODE_ENV: "development", OIDC_ISSUER_URL: "https://custom.example" }, () => {
    assert.equal(loadEnv().oidcIssuer, "https://custom.example");
  });
});

test("dev and test default a credential encryption key; production does not", () => {
  withEnv({ NODE_ENV: "development", ENCRYPTION_KEY: undefined }, () => {
    assert.ok(loadEnv().encryptionKey.length > 0, "dev should default a key");
  });
  withEnv({ NODE_ENV: "test", ENCRYPTION_KEY: undefined }, () => {
    assert.ok(loadEnv().encryptionKey.length > 0, "test should default a key");
  });
  withEnv({ NODE_ENV: "production", ENCRYPTION_KEY: undefined }, () => {
    assert.equal(loadEnv().encryptionKey, "", "production must require an explicit key");
  });
});
