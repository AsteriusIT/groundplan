/**
 * Vendored official AWS Architecture Icons (Q1 2025 asset package), used
 * **unmodified** (rendered as-is via <img>, never recoloured/altered) in the
 * architecture diagrams this app produces — see apps/frontend/ICONS.md for the
 * licensing note + attribution. Only the icons we map are committed under
 * `./aws/`; Vite bundles each as its own asset. Mirrors the GP-29 Azure module.
 */
import { iconUrlMap } from "./icon-assets";

/** The vendored AWS icon files (clean kebab names of `./aws/<key>.svg`). */
export type AwsIconKey =
  // compute / containers
  | "ec2"
  | "ec2-auto-scaling"
  | "lambda"
  | "ecs"
  | "eks"
  | "ecr"
  | "fargate"
  // network
  | "vpc"
  | "elb"
  | "cloudfront"
  | "route-53"
  | "api-gateway"
  | "internet-gateway"
  | "nat-gateway"
  | "network-interface"
  // storage / data
  | "s3"
  | "ebs"
  | "efs"
  | "rds"
  | "aurora"
  | "dynamodb"
  | "elasticache"
  // security / identity
  | "iam"
  | "iam-role"
  | "kms"
  | "secrets-manager"
  | "certificate-manager"
  | "waf"
  | "cognito"
  // messaging
  | "sqs"
  | "sns"
  | "eventbridge"
  | "step-functions"
  // observability
  | "cloudwatch";

// Vite resolves each SVG to a hashed asset URL at build time; only the committed
// files under ./aws are included.
const MODULES = import.meta.glob<string>("./aws/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

const URL_BY_KEY = iconUrlMap(MODULES);

/** All vendored AWS icon keys (used by the /styleguide gallery). */
export const AWS_ICON_KEYS = [...URL_BY_KEY.keys()].sort((a, b) =>
  a.localeCompare(b),
) as AwsIconKey[];

/** The asset URL for a vendored AWS icon. */
export function awsIconUrl(key: AwsIconKey): string | undefined {
  return URL_BY_KEY.get(key);
}
