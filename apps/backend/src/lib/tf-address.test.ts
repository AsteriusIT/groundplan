import { test } from "node:test";
import assert from "node:assert/strict";

import { isTerraformAddress } from "./tf-address.js";

test("accepts plain resource addresses", () => {
  assert.equal(isTerraformAddress("aws_s3_bucket.a"), true);
  assert.equal(isTerraformAddress("azurerm_virtual_network.main"), true);
  assert.equal(isTerraformAddress("data.aws_ami.ubuntu"), true);
});

test("accepts module-qualified and nested-module addresses", () => {
  assert.equal(isTerraformAddress("module.payments.aws_ecs_service.this"), true);
  assert.equal(isTerraformAddress("module.a.module.b.aws_s3_bucket.c"), true);
});

test("accepts count / for_each index suffixes", () => {
  assert.equal(isTerraformAddress("aws_instance.web[0]"), true);
  assert.equal(isTerraformAddress('aws_instance.web["primary"]'), true);
  assert.equal(isTerraformAddress("module.net[0].aws_subnet.a"), true);
});

test("rejects addresses that are not two dot-separated segments", () => {
  assert.equal(isTerraformAddress("aws_s3_bucket"), false);
  assert.equal(isTerraformAddress(""), false);
});

test("rejects addresses with whitespace or illegal characters", () => {
  assert.equal(isTerraformAddress("aws_s3_bucket .a"), false);
  assert.equal(isTerraformAddress("aws s3.a"), false);
  assert.equal(isTerraformAddress("aws_s3_bucket.a; drop table"), false);
  assert.equal(isTerraformAddress(".aws_s3_bucket.a"), false);
  assert.equal(isTerraformAddress("aws_s3_bucket.a."), false);
});
