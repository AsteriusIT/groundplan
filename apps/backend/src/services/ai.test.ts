import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { loadEnv } from "../config/env.js";
import {
  capInput,
  loadPrompt,
  realAiProvider,
  AiDisabledError,
  MAX_INPUT_CHARS,
} from "./ai.js";

test("a prompt is loaded from its file and versioned by its contents", () => {
  const prompt = loadPrompt("pr_summary");

  const path = fileURLToPath(new URL("../../prompts/pr-summary.md", import.meta.url));
  const contents = readFileSync(path, "utf8");
  assert.equal(prompt.system, contents, "the prompt IS the file, not a literal");

  // The version is the file's content hash — so editing the prompt invalidates
  // the cache with no manual version bump to forget.
  const expected = createHash("sha256").update(contents).digest("hex").slice(0, 12);
  assert.equal(prompt.version, expected);

  // Different prompts, different versions.
  assert.notEqual(prompt.version, loadPrompt("docs_explain").version);
});

test("input under the cap is untouched; over it, it is cut and says so", () => {
  const small = "# Change\n\n- one resource";
  assert.equal(capInput(small), small);

  const huge = "x".repeat(MAX_INPUT_CHARS + 500);
  const capped = capInput(huge);
  assert.ok(capped.length < huge.length);
  assert.match(capped, /input truncated/, "truncation is announced to the model");
  assert.ok(capped.startsWith("x".repeat(100)));
});

test("without an API key the provider reports no model and refuses to stream", () => {
  const provider = realAiProvider({ ...loadEnv(), aiApiKey: "" });

  assert.equal(provider.model, null, "model: null is the feature flag being off");
  assert.throws(
    () => provider.stream({ system: "s", prompt: "p" }),
    AiDisabledError,
  );
});

test("with an API key the provider reports the configured model", () => {
  const provider = realAiProvider({
    ...loadEnv(),
    aiApiKey: "sk-test-not-a-real-key",
    aiModel: "claude-opus-4-8",
  });
  assert.equal(provider.model, "claude-opus-4-8");
});
