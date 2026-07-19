import { describe, expect, it } from "vitest";

import { awsIconUrl } from "../icons/aws-icons";
import { AWS_ICON_MAP, AWS_PREFIX_MAP } from "../icons/aws";
import { resolveResourceIcon } from "../icons/resource-icon";
import { categorize } from "../lib/resource-category";

describe("AWS resource icons (GP-91)", () => {
  it("resolves an exact aws type to its AWS icon", () => {
    expect(resolveResourceIcon("aws_instance")).toEqual({
      kind: "aws",
      icon: "ec2",
    });
    expect(resolveResourceIcon("aws_s3_bucket")).toEqual({
      kind: "aws",
      icon: "s3",
    });
    expect(resolveResourceIcon("aws_dynamodb_table")).toEqual({
      kind: "aws",
      icon: "dynamodb",
    });
  });

  it("every mapped aws type resolves to an AWS icon (no fallbacks)", () => {
    for (const type of Object.keys(AWS_ICON_MAP)) {
      expect(resolveResourceIcon(type).kind, type).toBe("aws");
    }
  });

  it("every mapped icon key has a vendored official SVG", () => {
    const keys = [
      ...Object.values(AWS_ICON_MAP),
      ...Object.values(AWS_PREFIX_MAP),
    ];
    for (const key of keys) {
      expect(awsIconUrl(key), `missing src/icons/aws/${key}.svg`).toBeDefined();
    }
  });

  it("gives every icon-mapped type a category hue (no icon without a hue)", () => {
    for (const type of Object.keys(AWS_ICON_MAP)) {
      expect(categorize(type), type).not.toBe("other");
    }
  });

  it("falls back to the type-prefix heuristic for unmapped aws types", () => {
    // Not in the exact map, but the aws_s3 / aws_lambda prefixes are.
    expect(resolveResourceIcon("aws_s3_bucket_policy")).toEqual({
      kind: "aws",
      icon: "s3",
    });
    expect(resolveResourceIcon("aws_lambda_event_source_mapping")).toEqual({
      kind: "aws",
      icon: "lambda",
    });
  });

  it("prefers the longest matching prefix", () => {
    // aws_cloudwatch_event (EventBridge) must win over plain aws_cloudwatch.
    expect(resolveResourceIcon("aws_cloudwatch_event_target")).toEqual({
      kind: "aws",
      icon: "eventbridge",
    });
    expect(resolveResourceIcon("aws_cloudwatch_log_stream")).toEqual({
      kind: "aws",
      icon: "cloudwatch",
    });
  });
});
