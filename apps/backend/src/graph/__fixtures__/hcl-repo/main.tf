# Root module of the docs fixture repo.

terraform {
  required_version = ">= 1.5.0"
}

provider "aws" {
  region = "eu-west-1"
}

resource "aws_s3_bucket" "logs" {
  bucket = "logs"

  # Heredoc with braces/brackets the scanner must not count as blocks.
  policy = <<POLICY
{ "Statement": [{ "Effect": "Allow" }] }
POLICY
}

data "aws_caller_identity" "current" {}

resource "aws_iam_role" "app" {
  name       = "app"
  depends_on = [aws_s3_bucket.logs]

  # Nested block — must not be mistaken for a top-level block.
  inline_policy {
    name = "inline"
  }
}

# Local module — recurse into ./modules/network.
module "network" {
  source = "./modules/network"
}

# Registry module — a single leaf node, no recursion.
module "vpc_registry" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}
