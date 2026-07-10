import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  ApiError,
  createProject,
  createRepository,
  deleteProject,
  getMe,
  listProjects,
  setAuthTokenProvider,
  setOnUnauthorized,
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

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

/** The (url, init) of the first fetch call, with light typing for assertions. */
function firstCall(): { url: string; init: FetchInit } {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error("fetch was not called");
  return { url: String(call[0]), init: (call[1] ?? {}) as FetchInit };
}

it("listProjects GETs /api/v1/projects and returns typed data", async () => {
  const projects = [
    { id: "1", name: "A", slug: "a", createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  fetchMock.mockResolvedValue(jsonResponse(200, projects));

  const result = await listProjects();

  expect(result).toEqual(projects);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const { url, init } = firstCall();
  expect(url).toContain("/api/v1/projects");
  expect(init.method).toBe("GET");
});

it("createProject POSTs JSON with the right content-type", async () => {
  const created = {
    id: "1",
    name: "A",
    slug: "a",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  fetchMock.mockResolvedValue(jsonResponse(201, created));

  const result = await createProject({ name: "A", slug: "a" });

  expect(result).toEqual(created);
  const { init } = firstCall();
  expect(init.method).toBe("POST");
  expect(init.headers?.["Content-Type"]).toBe("application/json");
  expect(JSON.parse(init.body ?? "{}")).toEqual({ name: "A", slug: "a" });
});

it("createRepository returns the one-time webhookToken", async () => {
  const created = {
    id: "r1",
    projectId: "p1",
    provider: "github",
    url: "https://github.com/acme/repo",
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    webhookToken: "secret-once",
  };
  fetchMock.mockResolvedValue(jsonResponse(201, created));

  const result = await createRepository("p1", {
    provider: "github",
    url: "https://github.com/acme/repo",
  });

  expect(result.webhookToken).toBe("secret-once");
});

it("injects the bearer token from the configured provider", async () => {
  setAuthTokenProvider(() => "tok-123");
  fetchMock.mockResolvedValue(jsonResponse(200, []));

  await listProjects();

  expect(firstCall().init.headers?.Authorization).toBe("Bearer tok-123");
});

it("omits Authorization when there is no token", async () => {
  fetchMock.mockResolvedValue(jsonResponse(200, []));

  await listProjects();

  expect(firstCall().init.headers?.Authorization).toBeUndefined();
});

it("throws ApiError with status and server message on 422", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(422, { error: "Unprocessable Entity", message: "Validation failed" }),
  );

  const err = await createProject({ name: "", slug: "" }).catch(
    (e: unknown) => e,
  );

  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(422);
  expect((err as ApiError).message).toBe("Validation failed");
});

it("calls onUnauthorized exactly once on 401 and throws ApiError", async () => {
  const onUnauthorized = vi.fn();
  setOnUnauthorized(onUnauthorized);
  fetchMock.mockResolvedValue(
    jsonResponse(401, { error: "Unauthorized", message: "invalid or missing token" }),
  );

  const err = await getMe().catch((e: unknown) => e);

  expect(onUnauthorized).toHaveBeenCalledTimes(1);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(401);
});

it("returns undefined for 204 responses (deleteProject)", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

  await expect(deleteProject("p1")).resolves.toBeUndefined();
  const { url, init } = firstCall();
  expect(url).toContain("/api/v1/projects/p1");
  expect(init.method).toBe("DELETE");
});
