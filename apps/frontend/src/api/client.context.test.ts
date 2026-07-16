import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setAuthTokenProvider, setOnUnauthorized, updateProject } from "./client";

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

it("updateProject PATCHes /projects/:id with the context", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(200, { id: "p1", name: "P", slug: "p", contextMd: "hi", createdAt: "x" }),
  );
  const result = await updateProject("p1", { contextMd: "hi" });
  expect(result.contextMd).toBe("hi");
  const call = fetchMock.mock.calls[0]!;
  expect(String(call[0])).toBe("/api/v1/orgs/test-org/projects/p1");
  expect((call[1] as { method?: string }).method).toBe("PATCH");
  expect(JSON.parse((call[1] as { body?: string }).body ?? "{}")).toEqual({
    contextMd: "hi",
  });
});
