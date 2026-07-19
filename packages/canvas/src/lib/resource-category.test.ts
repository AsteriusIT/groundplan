import { expect, it } from "vitest";

import { categorize, isDataSource, shortType } from "./resource-category";

it("categorises a known type by its prefix", () => {
  expect(categorize("azurerm_virtual_network")).toBe("network");
  expect(categorize("azurerm_subnet")).toBe("network");
  expect(categorize("aws_instance")).toBe("compute");
  expect(categorize("aws_s3_bucket")).toBe("data");
  expect(categorize("aws_iam_role")).toBe("identity");
  expect(categorize("azurerm_monitor_diagnostic_setting")).toBe("observability");
  expect(categorize("aws_kms_key")).toBe("security");
});

it("falls back to 'other' for unknown types", () => {
  expect(categorize("acme_widget")).toBe("other");
  expect(categorize("aws_totally_made_up")).toBe("other");
});

it("returns 'other' for a non-prefixed / module type", () => {
  expect(categorize("module")).toBe("other");
  expect(categorize("random")).toBe("other");
});

it("isDataSource spots a data source at the root and inside modules", () => {
  expect(isDataSource("data.azurerm_subnet.existing")).toBe(true);
  expect(isDataSource("module.net.data.azurerm_subnet.existing")).toBe(true);
  expect(isDataSource("module.a.module.b.data.azurerm_client_config.c")).toBe(true);
  expect(isDataSource("azurerm_subnet.app")).toBe(false);
  expect(isDataSource("module.net.azurerm_subnet.app")).toBe(false);
});

it("isDataSource is not fooled by a module named 'data'", () => {
  expect(isDataSource("module.data.azurerm_subnet.app")).toBe(false);
  expect(isDataSource("module.data.data.azurerm_subnet.app")).toBe(true);
  expect(isDataSource("module.data")).toBe(false);
});

it("isDataSource ignores non-Terraform (Kubernetes) ids", () => {
  expect(isDataSource("prod/Deployment/api")).toBe(false);
});

it("shortType strips the provider prefix", () => {
  expect(shortType("azurerm_virtual_network")).toBe("virtual_network");
  expect(shortType("aws_s3_bucket")).toBe("s3_bucket");
  expect(shortType("google_compute_instance")).toBe("compute_instance");
  expect(shortType("module")).toBe("module");
});
