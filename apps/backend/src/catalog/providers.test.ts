/**
 * The allowlist (GP-234). It is a security boundary, not an inventory, so the
 * tests are mostly about what it *refuses*.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CATALOG_PROVIDERS,
  isAllowlisted,
  parseAllowlist,
  parseProviderId,
  providerId,
} from "./providers.js";

test("an empty configuration means the defaults", () => {
  assert.deepEqual(
    parseAllowlist("").map(providerId),
    [...DEFAULT_CATALOG_PROVIDERS],
  );
  assert.deepEqual(
    parseAllowlist(undefined).map(providerId),
    [...DEFAULT_CATALOG_PROVIDERS],
  );
});

test("a configured list replaces the defaults entirely", () => {
  assert.deepEqual(
    parseAllowlist("hashicorp/azurerm, hashicorp/random").map(providerId),
    ["hashicorp/azurerm", "hashicorp/random"],
  );
});

test("a duplicate entry is listed once", () => {
  assert.deepEqual(
    parseAllowlist("hashicorp/aws,hashicorp/aws").map(providerId),
    ["hashicorp/aws"],
  );
});

test("a malformed entry is dropped, never allowlisted, and never fails boot", () => {
  // Everything here would be a path traversal, a shell metacharacter or an
  // ambiguous address if it reached `terraform init`.
  const refs = parseAllowlist(
    [
      "hashicorp/azurerm",
      "../../etc/passwd",
      "hashicorp/az;rm -rf /",
      "registry.terraform.io/hashicorp/azurerm",
      "hashicorp",
      "/azurerm",
      "hashicorp/",
      "",
    ].join(","),
  );
  assert.deepEqual(refs.map(providerId), ["hashicorp/azurerm"]);
});

test("parseProviderId accepts exactly two well-formed segments", () => {
  assert.deepEqual(parseProviderId("hashicorp/azurerm"), {
    namespace: "hashicorp",
    name: "azurerm",
  });
  assert.equal(parseProviderId("hashicorp/azure rm"), null);
  assert.equal(parseProviderId("hashicorp/../azurerm"), null);
  assert.equal(parseProviderId("-bad/azurerm"), null);
});

test("isAllowlisted answers about the configured list and nothing else", () => {
  const allowlist = parseAllowlist("hashicorp/azurerm");
  assert.equal(
    isAllowlisted({ namespace: "hashicorp", name: "azurerm" }, allowlist),
    true,
  );
  assert.equal(
    isAllowlisted({ namespace: "hashicorp", name: "aws" }, allowlist),
    false,
  );
  // A namespace that merely *looks* like the allowed one is not it.
  assert.equal(
    isAllowlisted({ namespace: "hashicorp-evil", name: "azurerm" }, allowlist),
    false,
  );
});
