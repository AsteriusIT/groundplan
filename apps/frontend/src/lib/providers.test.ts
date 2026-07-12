import { describe, expect, it } from "vitest";

import {
  detectProvider,
  PROVIDER_LABELS,
  PROVIDER_PAT_HELP,
  PROVIDERS,
} from "./providers";

describe("detectProvider", () => {
  it("maps known SaaS hosts to their provider", () => {
    expect(detectProvider("https://github.com/acme/infra.git")).toBe("github");
    expect(detectProvider("https://gitlab.com/acme/infra")).toBe("gitlab");
    expect(detectProvider("https://dev.azure.com/acme/infra/_git/repo")).toBe(
      "azure_devops",
    );
    expect(detectProvider("https://acme.visualstudio.com/infra/_git/repo")).toBe(
      "azure_devops",
    );
  });

  it("falls back to generic for unknown / self-hosted hosts", () => {
    expect(detectProvider("https://gitlab.example.com/acme/infra")).toBe("generic");
    expect(detectProvider("https://git.internal.example.com/acme/infra.git")).toBe(
      "generic",
    );
  });

  it("is case-insensitive and tolerant of an empty / bad URL", () => {
    expect(detectProvider("https://GitHub.com/Acme/Infra")).toBe("github");
    expect(detectProvider("")).toBe("generic");
    expect(detectProvider("not a url")).toBe("generic");
  });
});

describe("provider metadata", () => {
  it("has a label and PAT help entry for every provider", () => {
    for (const p of PROVIDERS) {
      expect(PROVIDER_LABELS[p]).toBeTruthy();
      expect(PROVIDER_PAT_HELP[p].hint).toBeTruthy();
    }
  });

  it("names the minimal scope per provider", () => {
    expect(PROVIDER_PAT_HELP.github.hint).toMatch(/contents/i);
    expect(PROVIDER_PAT_HELP.gitlab.hint).toMatch(/read_repository/i);
    expect(PROVIDER_PAT_HELP.azure_devops.hint).toMatch(/code/i);
    expect(PROVIDER_PAT_HELP.generic.hint).toMatch(/any https/i);
  });
});
