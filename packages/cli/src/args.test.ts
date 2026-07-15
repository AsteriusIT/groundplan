import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, stringFlag } from "./args.js";

test("parses a command and --flag value pairs", () => {
  const { command, flags } = parseArgs(["push-plan", "--file", "plan.json"]);
  assert.equal(command, "push-plan");
  assert.equal(flags.file, "plan.json");
});

test("parses --flag=value form", () => {
  const { flags } = parseArgs(["push-plan", "--url=https://x/y", "--pr=42"]);
  assert.equal(flags.url, "https://x/y");
  assert.equal(flags.pr, "42");
});

test("a bare --flag, or one followed by another flag, is boolean true", () => {
  const { flags } = parseArgs(["push-plan", "--help", "--file", "p"]);
  assert.equal(flags.help, true);
  assert.equal(flags.file, "p");
});

test("stringFlag returns the value only when it is a string", () => {
  assert.equal(stringFlag("plan.json"), "plan.json");
  assert.equal(stringFlag(true), undefined);
  assert.equal(stringFlag(undefined), undefined);
});
