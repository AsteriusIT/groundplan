import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ApiError, parsePlayground, setAuthTokenProvider, setOnUnauthorized } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setAuthTokenProvider(() => null);
  setOnUnauthorized(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const FILES = [{ path: "main.tf", content: `resource "x" "y" {}` }];

it("parsePlayground POSTs the files to the global (non-org) parse endpoint", async () => {
  const snapshot = {
    graph: { version: 1, nodes: [], edges: [] },
    stats: {
      nodes: 0,
      edges: 0,
      changes: { create: 0, update: 0, delete: 0, noop: 0, unchanged: 0 },
    },
    summaryMd: "",
  };
  fetchMock.mockResolvedValue(jsonResponse(200, snapshot));

  const result = await parsePlayground(FILES);

  expect(result).toEqual(snapshot);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  // Drafts and parse are user-scoped: no /orgs/:orgId segment.
  expect(url).toContain("/api/v1/playground/parse");
  expect(url).not.toContain("/orgs/");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({ files: FILES });
});

it("a 422 surfaces the per-file details on ApiError.fields", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(422, {
      error: "Unprocessable Entity",
      message: "HCL parse failed",
      fields: [{ field: "broken.tf", message: "unbalanced braces" }],
    }),
  );

  const err = await parsePlayground(FILES).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(422);
  expect((err as ApiError).message).toBe("HCL parse failed");
  expect((err as ApiError).fields).toEqual([
    { field: "broken.tf", message: "unbalanced braces" },
  ]);
});
