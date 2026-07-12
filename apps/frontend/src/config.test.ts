import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { webhookUrl } from "@/api/client";

import {
  DEFAULT_CONFIG,
  getConfig,
  loadConfig,
  setConfig,
} from "./config";

const fetchMock = vi.fn();

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  // Reset the module singleton between tests.
  setConfig(DEFAULT_CONFIG);
  // Loader failures log a warning by design — keep test output quiet.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("returns the built-in defaults before loadConfig runs", () => {
  expect(getConfig()).toEqual(DEFAULT_CONFIG);
});

it("merges a full config.json over the defaults", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(200, {
      apiUrl: "https://api.example.com",
      oidcIssuer: "https://auth.example.com/realms/groundplan",
      oidcClientId: "custom-client",
      oidcRedirectUri: "https://app.example.com/callback",
    }),
  );

  const config = await loadConfig();

  expect(config).toEqual({
    apiUrl: "https://api.example.com",
    oidcIssuer: "https://auth.example.com/realms/groundplan",
    oidcClientId: "custom-client",
    oidcRedirectUri: "https://app.example.com/callback",
  });
  expect(getConfig()).toEqual(config);
  expect(fetchMock).toHaveBeenCalledWith("/config.json", { cache: "no-store" });
});

it("merges per-key — missing keys keep their defaults", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(200, { oidcIssuer: "https://auth.example.com/realms/gp" }),
  );

  const config = await loadConfig();

  expect(config).toEqual({
    ...DEFAULT_CONFIG,
    oidcIssuer: "https://auth.example.com/realms/gp",
  });
});

it("ignores unknown and wrong-typed keys", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(200, { apiUrl: 42, somethingElse: "x" }),
  );

  const config = await loadConfig();

  expect(config).toEqual(DEFAULT_CONFIG);
});

it("falls back to defaults on a non-2xx response", async () => {
  fetchMock.mockResolvedValue(jsonResponse(404));

  await expect(loadConfig()).resolves.toEqual(DEFAULT_CONFIG);
  expect(getConfig()).toEqual(DEFAULT_CONFIG);
});

it("falls back to defaults on a network error", async () => {
  fetchMock.mockRejectedValue(new Error("network down"));

  await expect(loadConfig()).resolves.toEqual(DEFAULT_CONFIG);
});

it("falls back to defaults on invalid JSON", async () => {
  fetchMock.mockResolvedValue(
    new Response("{ not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  await expect(loadConfig()).resolves.toEqual(DEFAULT_CONFIG);
});

it("propagates apiUrl to the API client (lazy read)", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(200, { apiUrl: "https://api.example.com" }),
  );

  await loadConfig();

  expect(webhookUrl("r1")).toBe(
    "https://api.example.com/api/v1/webhooks/ci/r1",
  );
});
