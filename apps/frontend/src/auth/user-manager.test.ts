import { afterEach, expect, it } from "vitest";

import { DEFAULT_CONFIG, setConfig } from "@/config";

import { createUserManager } from "./user-manager";

afterEach(() => {
  setConfig(DEFAULT_CONFIG);
});

it("builds the UserManager from the runtime config", () => {
  setConfig({
    apiUrl: "",
    oidcIssuer: "https://auth.example.com/realms/groundplan",
    oidcClientId: "custom-client",
  });

  const manager = createUserManager();

  expect(manager.settings.authority).toBe(
    "https://auth.example.com/realms/groundplan",
  );
  expect(manager.settings.client_id).toBe("custom-client");
  // No explicit redirect in config → derived from the current origin.
  expect(manager.settings.redirect_uri).toBe(
    `${window.location.origin}/callback`,
  );
});

it("honours an explicit oidcRedirectUri from config", () => {
  setConfig({
    ...DEFAULT_CONFIG,
    oidcRedirectUri: "https://app.example.com/callback",
  });

  const manager = createUserManager();

  expect(manager.settings.redirect_uri).toBe(
    "https://app.example.com/callback",
  );
});
