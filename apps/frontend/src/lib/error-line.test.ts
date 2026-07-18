import { expect, it } from "vitest";

import { errorLineOf } from "./error-line";

it("reads 'line N' wherever it appears in the message", () => {
  expect(errorLineOf("unbalanced braces at line 42")).toBe(42);
  expect(errorLineOf("Line 3: unexpected token")).toBe(3);
});

it("reads a trailing :N file-position suffix", () => {
  expect(errorLineOf("unexpected token in network.tf:17")).toBe(17);
  expect(errorLineOf("network.tf:17:4 unexpected token")).toBe(17);
});

it("prefers the explicit 'line N' form over a :N suffix", () => {
  expect(errorLineOf("main.tf:9 parse error at line 12")).toBe(12);
});

it("returns null when the message names no line", () => {
  expect(errorLineOf("unbalanced braces")).toBeNull();
  expect(errorLineOf("only .tf and .tfvars files are allowed")).toBeNull();
});
