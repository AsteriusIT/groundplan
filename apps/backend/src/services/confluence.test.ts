/**
 * Integration tests for the real Confluence client (GP-179) against a local
 * in-process HTTP server — the "mocked Confluence" the story asks for. Both
 * editions are exercised: Cloud (Basic email:token) and Data Center (Bearer
 * PAT); the REST v1 surface is identical, only the header differs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { realConfluenceClient, type ConfluenceTarget } from "./confluence.js";

type Seen = { path: string; authorization: string | undefined };

/** A one-space Confluence: GET /rest/api/space/DOCS exists, everything else 404s. */
function fakeConfluence(opts: { expectAuth: string; status?: number }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    if (req.headers.authorization !== opts.expectAuth) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "unauthorized" }));
    }
    if (opts.status) {
      res.writeHead(opts.status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "boom" }));
    }
    if (req.url === "/rest/api/space/DOCS") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ key: "DOCS", name: "Documentation" }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "no such space" }));
  });
  return { server, seen };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function cloudTarget(baseUrl: string): ConfluenceTarget {
  return {
    baseUrl,
    authType: "cloud_token",
    email: "docs@acme.test",
    credential: "cloud-api-token",
  };
}

const CLOUD_AUTH = `Basic ${Buffer.from("docs@acme.test:cloud-api-token").toString("base64")}`;

test("cloud edition: Basic email:token reaches the space and verifies ok", async () => {
  const { server, seen } = fakeConfluence({ expectAuth: CLOUD_AUTH });
  const baseUrl = await listen(server);
  try {
    const result = await realConfluenceClient.verifySpace(cloudTarget(baseUrl), "DOCS");
    assert.deepEqual(result, { ok: true, spaceName: "Documentation" });
    assert.equal(seen[0]?.path, "/rest/api/space/DOCS");
    assert.equal(seen[0]?.authorization, CLOUD_AUTH);
  } finally {
    server.close();
  }
});

test("data center edition: Bearer PAT verifies ok; a trailing slash on the base URL is harmless", async () => {
  const { server, seen } = fakeConfluence({ expectAuth: "Bearer dc-pat" });
  const baseUrl = await listen(server);
  try {
    const result = await realConfluenceClient.verifySpace(
      { baseUrl: `${baseUrl}/`, authType: "dc_pat", email: null, credential: "dc-pat" },
      "DOCS",
    );
    assert.deepEqual(result, { ok: true, spaceName: "Documentation" });
    assert.equal(seen[0]?.path, "/rest/api/space/DOCS");
    assert.equal(seen[0]?.authorization, "Bearer dc-pat");
  } finally {
    server.close();
  }
});

test("a bad credential (401) is auth_failed, and 403 too", async () => {
  const { server } = fakeConfluence({ expectAuth: "Bearer right" });
  const baseUrl = await listen(server);
  try {
    const unauthorized = await realConfluenceClient.verifySpace(
      { baseUrl, authType: "dc_pat", email: null, credential: "wrong" },
      "DOCS",
    );
    assert.deepEqual(unauthorized, { ok: false, error: "auth_failed" });

    const forbidden = fakeConfluence({ expectAuth: "Bearer right", status: 403 });
    const forbiddenUrl = await listen(forbidden.server);
    try {
      const result = await realConfluenceClient.verifySpace(
        { baseUrl: forbiddenUrl, authType: "dc_pat", email: null, credential: "right" },
        "DOCS",
      );
      assert.deepEqual(result, { ok: false, error: "auth_failed" });
    } finally {
      forbidden.server.close();
    }
  } finally {
    server.close();
  }
});

test("an unknown space (404) is space_not_found — distinct from a bad credential", async () => {
  const { server } = fakeConfluence({ expectAuth: "Bearer pat" });
  const baseUrl = await listen(server);
  try {
    const result = await realConfluenceClient.verifySpace(
      { baseUrl, authType: "dc_pat", email: null, credential: "pat" },
      "NOPE",
    );
    assert.deepEqual(result, { ok: false, error: "space_not_found" });
  } finally {
    server.close();
  }
});

test("an unreachable instance is network, never a thrown error", async () => {
  // Grab a port, then close it: nothing listens there any more.
  const { server } = fakeConfluence({ expectAuth: "Bearer pat" });
  const baseUrl = await listen(server);
  await new Promise((resolve) => server.close(resolve));

  const result = await realConfluenceClient.verifySpace(
    { baseUrl, authType: "dc_pat", email: null, credential: "pat" },
    "DOCS",
  );
  assert.deepEqual(result, { ok: false, error: "network" });
});
