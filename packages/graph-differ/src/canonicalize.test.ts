import { test } from "node:test";
import assert from "node:assert/strict";

import type { GraphNode } from "@groundplan/graph-parser";

import { canonicalAttributes } from "./canonicalize.js";

function hclNode(code: string, file = "main.tf", startLine = 1): GraphNode {
  return {
    id: "aws_s3_bucket.b",
    name: "b",
    type: "aws_s3_bucket",
    provider: "aws",
    module_path: [],
    change: null,
    source: {
      file,
      start_line: startLine,
      end_line: startLine + code.split("\n").length - 1,
      code,
    },
  };
}

test("extracts top-level attributes as normalized expression text", () => {
  const node = hclNode(
    `resource "aws_s3_bucket" "b" {
  bucket = "my-bucket"
  acl    = var.acl
  count  = 2
}`,
  );
  assert.deepEqual(canonicalAttributes(node), {
    bucket: '"my-bucket"',
    acl: "var.acl",
    count: "2",
  });
});

test("formatting-only differences canonicalize identically", () => {
  const oneLine = hclNode(
    `resource "aws_s3_bucket" "b" {
  tags = { env = "prod", team = "core" }
  zones = ["a", "b"]
}`,
  );
  const reformatted = hclNode(
    `resource "aws_s3_bucket" "b" {
  tags = {
    env  = "prod"
    team = "core"
  }
  zones = [
    "a",
    "b",
  ]
}`,
  );
  assert.deepEqual(canonicalAttributes(oneLine), canonicalAttributes(reformatted));
});

test("whitespace inside quoted strings is preserved", () => {
  const node = hclNode(
    `resource "aws_s3_bucket" "b" {
  description = "two  spaces   stay"
}`,
  );
  assert.deepEqual(canonicalAttributes(node), {
    description: '"two  spaces   stay"',
  });
});

test("comments do not participate in the canonical form", () => {
  const withComments = hclNode(
    `resource "aws_s3_bucket" "b" {
  # a full-line comment
  bucket = "x" // trailing comment
  /* block
     comment */
  acl = "private"
}`,
  );
  const bare = hclNode(
    `resource "aws_s3_bucket" "b" {
  bucket = "x"
  acl = "private"
}`,
  );
  assert.deepEqual(canonicalAttributes(withComments), canonicalAttributes(bare));
});

test("nested blocks flatten to dotted paths; repeated blocks are indexed", () => {
  const node = hclNode(
    `resource "azurerm_network_security_group" "nsg" {
  name = "nsg"
  security_rule {
    name     = "http"
    priority = 100
  }
  security_rule {
    name     = "ssh"
    priority = 200
  }
  identity {
    type = "SystemAssigned"
  }
}`,
  );
  assert.deepEqual(canonicalAttributes(node), {
    name: '"nsg"',
    "security_rule[0].name": '"http"',
    "security_rule[0].priority": "100",
    "security_rule[1].name": '"ssh"',
    "security_rule[1].priority": "200",
    "identity.type": '"SystemAssigned"',
  });
});

test("labelled nested blocks carry their labels in the path", () => {
  const node = hclNode(
    `resource "aws_instance" "i" {
  dynamic "ebs_block_device" {
    for_each = var.disks
  }
}`,
  );
  assert.deepEqual(canonicalAttributes(node), {
    "dynamic.ebs_block_device.for_each": "var.disks",
  });
});

test("file and line position never affect the canonical form", () => {
  const code = `resource "aws_s3_bucket" "b" {
  bucket = "x"
}`;
  const here = hclNode(code, "main.tf", 1);
  const elsewhere = hclNode(code, "moved/storage.tf", 400);
  assert.deepEqual(canonicalAttributes(here), canonicalAttributes(elsewhere));
});

test("heredoc bodies are preserved verbatim", () => {
  const node = hclNode(
    `resource "aws_iam_policy" "p" {
  policy = <<EOF
{
  "a":  1
}
EOF
}`,
  );
  const attrs = canonicalAttributes(node);
  assert.match(attrs["policy"] ?? "", /"a": {2}1/);
});

test("multi-line ternaries and bracket spacing normalize away", () => {
  const spaced = hclNode(
    `resource "aws_s3_bucket" "b" {
  acl = var.public ? "public-read" : "private"
  ids = [ aws_kms_key.k.arn ]
}`,
  );
  const tight = hclNode(
    `resource "aws_s3_bucket" "b" {
  acl = var.public?"public-read":"private"
  ids = [aws_kms_key.k.arn]
}`,
  );
  assert.deepEqual(canonicalAttributes(spaced), canonicalAttributes(tight));
});

test("a node without source falls back to its attributes bag", () => {
  const node: GraphNode = {
    id: "prod/Deployment/api",
    name: "api",
    type: "Deployment",
    provider: null,
    module_path: [],
    change: null,
    attributes: { "spec.replicas": "3" },
  };
  assert.deepEqual(canonicalAttributes(node), { "spec.replicas": "3" });
});

test("a node with neither source nor attributes is empty", () => {
  const node: GraphNode = {
    id: "module.net",
    name: "net",
    type: "module",
    provider: null,
    module_path: [],
    change: null,
  };
  assert.deepEqual(canonicalAttributes(node), {});
});
