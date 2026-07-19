import { test } from "node:test";
import assert from "node:assert/strict";

import { computeAttributeDiff, render } from "./attribute-diff.js";

test("noop changes never produce a diff", () => {
  const out = computeAttributeDiff(
    { before: { a: 1 }, after: { a: 2 } },
    "noop",
  );
  assert.deepEqual(out, { rows: [], truncated: false });
});

test("update reports only the attributes that actually changed", () => {
  const out = computeAttributeDiff(
    {
      before: { sku_name: "S0", max_size_gb: 2, zone_redundant: false },
      after: { sku_name: "P1", max_size_gb: 2, zone_redundant: true },
    },
    "update",
  );
  assert.equal(out.truncated, false);
  assert.deepEqual(out.rows, [
    { key: "sku_name", before: "S0", after: "P1" },
    { key: "zone_redundant", before: "false", after: "true" },
  ]);
});

test("sensitive attributes are masked on both sides — never plaintext", () => {
  const out = computeAttributeDiff(
    {
      before: { password: "oldpw-PLAINTEXT" },
      after: { password: "newpw-PLAINTEXT" },
      before_sensitive: { password: true },
      after_sensitive: { password: true },
    },
    "update",
  );
  assert.deepEqual(out.rows, [
    { key: "password", before: "(sensitive)", after: "(sensitive)" },
  ]);
  assert.ok(!JSON.stringify(out).includes("PLAINTEXT"));
});

test("a whole-object sensitive flag (true) masks every attribute", () => {
  const out = computeAttributeDiff(
    {
      before: { a: "SECRET-A" },
      after: { a: "SECRET-B" },
      after_sensitive: true,
    },
    "update",
  );
  assert.deepEqual(out.rows, [
    { key: "a", before: "(sensitive)", after: "(sensitive)" },
  ]);
  assert.ok(!JSON.stringify(out).includes("SECRET"));
});

test("computed (unknown) attributes render as (known after apply)", () => {
  const out = computeAttributeDiff(
    {
      before: null,
      after: { account_tier: "Standard" },
      after_unknown: { id: true, primary_access_key: true },
    },
    "create",
  );
  assert.deepEqual(out.rows, [
    { key: "account_tier", before: null, after: "Standard" },
    { key: "id", before: null, after: "(known after apply)" },
    { key: "primary_access_key", before: null, after: "(known after apply)" },
  ]);
});

test("sensitive wins over known-after-apply so plaintext never leaks", () => {
  const out = computeAttributeDiff(
    {
      before: null,
      after: { secret: "leaked" },
      after_unknown: { secret: true },
      after_sensitive: { secret: true },
    },
    "create",
  );
  assert.deepEqual(out.rows, [
    { key: "secret", before: null, after: "(sensitive)" },
  ]);
});

test("create rows have a null before; delete rows have a null after", () => {
  const created = computeAttributeDiff(
    { before: null, after: { name: "web" } },
    "create",
  );
  assert.deepEqual(created.rows, [{ key: "name", before: null, after: "web" }]);

  const deleted = computeAttributeDiff(
    { before: { name: "web" }, after: null },
    "delete",
  );
  assert.deepEqual(deleted.rows, [{ key: "name", before: "web", after: null }]);
});

test("nested objects/arrays collapse to the deep-change marker", () => {
  const out = computeAttributeDiff(
    {
      before: { tags: { env: "prod" }, ports: [80] },
      after: { tags: { env: "staging" }, ports: [80, 443] },
    },
    "update",
  );
  assert.deepEqual(out.rows, [
    { key: "ports", before: "{…}", after: "{…}" },
    { key: "tags", before: "{…}", after: "{…}" },
  ]);
});

test("more than 20 changed attributes are capped and flagged truncated", () => {
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  for (let i = 0; i < 25; i++) {
    // zero-padded so ascending key sort is stable and predictable
    const k = `attr_${String(i).padStart(2, "0")}`;
    before[k] = i;
    after[k] = i + 1;
  }
  const out = computeAttributeDiff({ before, after }, "update");
  assert.equal(out.rows.length, 20);
  assert.equal(out.truncated, true);
  assert.equal(out.rows[0]?.key, "attr_00");
  assert.equal(out.rows[19]?.key, "attr_19");
});

test("exactly 20 changed attributes are not truncated", () => {
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  for (let i = 0; i < 20; i++) {
    before[`k${String(i).padStart(2, "0")}`] = i;
    after[`k${String(i).padStart(2, "0")}`] = i + 1;
  }
  const out = computeAttributeDiff({ before, after }, "update");
  assert.equal(out.rows.length, 20);
  assert.equal(out.truncated, false);
});

test("long values are truncated to 200 chars with a trailing ellipsis", () => {
  const out = computeAttributeDiff(
    { before: null, after: { blob: "x".repeat(250) } },
    "create",
  );
  const row = out.rows[0];
  assert.equal(row?.key, "blob");
  assert.equal(row?.after?.length, 201);
  assert.ok(row?.after?.endsWith("…"));
  assert.equal(row?.after, "x".repeat(200) + "…");
});

test("render(): scalars verbatim, structures marked, values truncated", () => {
  assert.equal(render("hello"), "hello");
  assert.equal(render(null), "null");
  assert.equal(render(42), "42");
  assert.equal(render(0), "0");
  assert.equal(render(true), "true");
  assert.equal(render(false), "false");
  assert.equal(render(9007199254740993n), "9007199254740993");
  assert.equal(render({ a: 1 }), "{…}");
  assert.equal(render([1, 2, 3]), "{…}");
  assert.equal(render("y".repeat(500)), "y".repeat(200) + "…");
});
