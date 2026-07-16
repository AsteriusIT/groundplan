import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  setAuthTokenProvider,
  setOnUnauthorized,
  updateAnnotation,
} from "./client";

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

type FetchInit = { method?: string; body?: string };
function call(i = 0): { url: string; init: FetchInit } {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error("fetch was not called");
  return { url: String(c[0]), init: (c[1] ?? {}) as FetchInit };
}

it("listAnnotations GETs the repository's annotations", async () => {
  fetchMock.mockResolvedValue(jsonResponse(200, []));
  await listAnnotations("repo-1");
  expect(call().url).toBe("/api/v1/orgs/test-org/repositories/repo-1/annotations");
  expect(call().init.method ?? "GET").toBe("GET");
});

it("createAnnotation POSTs to the repository with the payload", async () => {
  fetchMock.mockResolvedValue(jsonResponse(201, { id: "a1" }));
  const input = { type: "note" as const, anchors: ["aws_s3_bucket.a"], body: "hi" };
  const result = await createAnnotation("repo-1", input);
  expect(result).toEqual({ id: "a1" });
  expect(call().url).toBe("/api/v1/orgs/test-org/repositories/repo-1/annotations");
  expect(call().init.method).toBe("POST");
  expect(JSON.parse(call().init.body ?? "{}")).toEqual(input);
});

it("updateAnnotation PATCHes /annotations/:id", async () => {
  fetchMock.mockResolvedValue(jsonResponse(200, { id: "a1", body: "x" }));
  await updateAnnotation("a1", { body: "x" });
  expect(call().url).toBe("/api/v1/orgs/test-org/annotations/a1");
  expect(call().init.method).toBe("PATCH");
});

it("deleteAnnotation DELETEs /annotations/:id and resolves on 204", async () => {
  fetchMock.mockResolvedValue(jsonResponse(204));
  await expect(deleteAnnotation("a1")).resolves.toBeUndefined();
  expect(call().url).toBe("/api/v1/orgs/test-org/annotations/a1");
  expect(call().init.method).toBe("DELETE");
});
