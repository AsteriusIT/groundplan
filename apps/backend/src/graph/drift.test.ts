/**
 * GP-206: reading a `terraform plan -refresh-only` into a drift report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NotRefreshOnlyError,
  parseDriftPlan,
  refreshOnlyRejection,
  summarizeDrift,
} from "./drift.js";

/** A refresh-only plan: nothing planned, one resource changed under our feet. */
const REFRESH_ONLY = {
  format_version: "1.2",
  terraform_version: "1.9.5",
  resource_changes: [],
  resource_drift: [
    {
      address: "azurerm_storage_account.data",
      mode: "managed",
      type: "azurerm_storage_account",
      name: "data",
      provider_name: "registry.terraform.io/hashicorp/azurerm",
      change: {
        actions: ["update"],
        before: { min_tls_version: "TLS1_2", access_key: "old" },
        after: { min_tls_version: "TLS1_0", access_key: "new" },
        before_sensitive: { access_key: true },
        after_sensitive: { access_key: true },
      },
    },
  ],
};

test("a refresh-only plan yields the drifted resources with their before→after", () => {
  const report = parseDriftPlan(REFRESH_ONLY);

  assert.equal(report.version, 1);
  assert.deepEqual(report.counts, { updated: 1, deleted: 0, total: 1 });
  assert.equal(report.resources.length, 1);
  const [drifted] = report.resources;
  assert.equal(drifted?.address, "azurerm_storage_account.data");
  assert.equal(drifted?.type, "azurerm_storage_account");
  assert.equal(drifted?.provider, "azurerm");
  assert.equal(drifted?.change, "update");
  assert.deepEqual(drifted?.attribute_diff, [
    { key: "access_key", before: "(sensitive)", after: "(sensitive)" },
    { key: "min_tls_version", before: "TLS1_2", after: "TLS1_0" },
  ]);
});

test("a sensitive value never reaches the report", () => {
  const report = parseDriftPlan(REFRESH_ONLY);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('"old"'), "the before value leaked");
  assert.ok(!serialized.includes('"new"'), "the after value leaked");
  assert.ok(serialized.includes("(sensitive)"));
});

test("a resource deleted outside Terraform is drift, not a planned destroy", () => {
  const report = parseDriftPlan({
    format_version: "1.2",
    resource_changes: [],
    resource_drift: [
      {
        address: "aws_s3_bucket.logs",
        mode: "managed",
        type: "aws_s3_bucket",
        name: "logs",
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: { actions: ["delete"], before: { bucket: "logs" }, after: null },
      },
    ],
  });

  assert.deepEqual(report.counts, { updated: 0, deleted: 1, total: 1 });
  assert.equal(report.resources[0]?.change, "delete");
});

test("a resource inside a module keeps its module path", () => {
  const report = parseDriftPlan({
    format_version: "1.2",
    resource_changes: [],
    resource_drift: [
      {
        address: "module.network.azurerm_subnet.web",
        module_address: "module.network",
        mode: "managed",
        type: "azurerm_subnet",
        name: "web",
        provider_name: "registry.terraform.io/hashicorp/azurerm",
        change: {
          actions: ["update"],
          before: { address_prefixes: "10.0.0.0/24" },
          after: { address_prefixes: "10.0.0.0/16" },
        },
      },
    ],
  });

  assert.deepEqual(report.resources[0]?.module_path, ["network"]);
});

test("a plan with nothing drifted is a valid, honest report", () => {
  const report = parseDriftPlan({
    format_version: "1.2",
    resource_changes: [],
  });

  assert.deepEqual(report.counts, { updated: 0, deleted: 0, total: 0 });
  assert.deepEqual(report.resources, []);
});

test("data reads are not drift", () => {
  const report = parseDriftPlan({
    format_version: "1.2",
    resource_changes: [],
    resource_drift: [
      {
        address: "data.azurerm_client_config.current",
        mode: "data",
        type: "azurerm_client_config",
        name: "current",
        change: { actions: ["update"], before: { a: 1 }, after: { a: 2 } },
      },
    ],
  });

  assert.deepEqual(report.resources, []);
});

test("resources are ordered by address, so the same plan yields the same report", () => {
  const drift = (address: string, type: string) => ({
    address,
    mode: "managed",
    type,
    name: address.split(".").pop(),
    change: { actions: ["update"], before: { a: "1" }, after: { a: "2" } },
  });
  const first = parseDriftPlan({
    format_version: "1.2",
    resource_changes: [],
    resource_drift: [drift("b.z", "b"), drift("a.y", "a")],
  });
  const second = parseDriftPlan({
    format_version: "1.2",
    resource_changes: [],
    resource_drift: [drift("a.y", "a"), drift("b.z", "b")],
  });

  assert.deepEqual(
    first.resources.map((r) => r.address),
    ["a.y", "b.z"],
  );
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

// --- The coherence gate -----------------------------------------------------

test("a pull-request plan is refused: it plans changes, so it measures nothing", () => {
  const prPlan = {
    format_version: "1.2",
    resource_changes: [
      {
        address: "azurerm_storage_account.data",
        mode: "managed",
        type: "azurerm_storage_account",
        name: "data",
        change: { actions: ["create"], before: null, after: { name: "data" } },
      },
    ],
  };

  assert.equal(refreshOnlyRejection(prPlan)?.includes("create"), true);
  assert.throws(() => parseDriftPlan(prPlan), NotRefreshOnlyError);
});

test("a plan that would only update is refused too — the code still wants a change", () => {
  const rejection = refreshOnlyRejection({
    format_version: "1.2",
    resource_changes: [
      {
        address: "a.b",
        mode: "managed",
        type: "a",
        name: "b",
        change: { actions: ["update"], before: { x: 1 }, after: { x: 2 } },
      },
    ],
  });

  assert.ok(rejection);
  assert.match(rejection, /-refresh-only/);
});

test("no-op and read entries are what a refresh-only plan looks like", () => {
  assert.equal(
    refreshOnlyRejection({
      format_version: "1.2",
      resource_changes: [
        {
          address: "a.b",
          mode: "managed",
          type: "a",
          name: "b",
          change: { actions: ["no-op"] },
        },
        {
          address: "data.a.c",
          mode: "data",
          type: "a",
          name: "c",
          change: { actions: ["read"] },
        },
      ],
    }),
    null,
  );
});

test("something that is not a Terraform plan is refused before anything else", () => {
  const rejection = refreshOnlyRejection({ hello: "world" });
  assert.ok(rejection);
  assert.match(rejection, /terraform show -json/);
});

// --- The deterministic summary ---------------------------------------------

test("the summary names what changed outside Terraform", () => {
  const md = summarizeDrift(parseDriftPlan(REFRESH_ONLY));
  assert.match(md, /1 resource has drifted/);
  assert.match(md, /azurerm_storage_account\.data/);
  assert.match(md, /min_tls_version/);
});

test("no drift says so rather than printing an empty list", () => {
  const md = summarizeDrift(
    parseDriftPlan({ format_version: "1.2", resource_changes: [] }),
  );
  assert.match(md, /matches the code/);
});
