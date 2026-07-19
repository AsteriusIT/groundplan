/**
 * aws resource type → official AWS Architecture Icon (GP-91). Same machinery as
 * the GP-29 Azure map — two tables:
 *
 *  - `AWS_ICON_MAP` — exact `aws_*` type → icon, covering the common estate
 *    (compute / containers / network / storage / data / identity / messaging /
 *    observability).
 *  - `AWS_PREFIX_MAP` — type-prefix → icon heuristic, so a type we didn't map
 *    explicitly (`aws_s3_bucket_policy`, a brand-new resource) still lands on the
 *    right service icon. Longest prefix wins (see resolver).
 *
 * Everything the tables miss falls back to the lucide category glyph — by design,
 * not a gap. Sub-resources with no dedicated official icon (subnet, route table,
 * security group) point at their parent-service icon (VPC).
 */
import type { AwsIconKey } from "./aws-icons";

export const AWS_ICON_MAP: Record<string, AwsIconKey> = {
  // compute
  aws_instance: "ec2",
  aws_spot_instance_request: "ec2",
  aws_launch_template: "ec2",
  aws_launch_configuration: "ec2",
  aws_autoscaling_group: "ec2-auto-scaling",
  aws_autoscaling_policy: "ec2-auto-scaling",
  aws_lambda_function: "lambda",
  aws_lambda_alias: "lambda",
  aws_lambda_permission: "lambda",
  // containers
  aws_ecs_cluster: "ecs",
  aws_ecs_service: "ecs",
  aws_ecs_task_definition: "ecs",
  aws_eks_cluster: "eks",
  aws_eks_node_group: "eks",
  aws_eks_fargate_profile: "fargate",
  aws_ecr_repository: "ecr",
  // network
  aws_vpc: "vpc",
  aws_subnet: "vpc",
  aws_route_table: "vpc",
  aws_route: "vpc",
  aws_security_group: "vpc",
  aws_lb: "elb",
  aws_alb: "elb",
  aws_lb_target_group: "elb",
  aws_lb_listener: "elb",
  aws_elb: "elb",
  aws_cloudfront_distribution: "cloudfront",
  aws_route53_zone: "route-53",
  aws_route53_record: "route-53",
  aws_internet_gateway: "internet-gateway",
  aws_nat_gateway: "nat-gateway",
  aws_network_interface: "network-interface",
  aws_api_gateway_rest_api: "api-gateway",
  aws_apigatewayv2_api: "api-gateway",
  // storage / data
  aws_s3_bucket: "s3",
  aws_ebs_volume: "ebs",
  aws_efs_file_system: "efs",
  aws_db_instance: "rds",
  aws_rds_cluster: "aurora",
  aws_rds_cluster_instance: "aurora",
  aws_dynamodb_table: "dynamodb",
  aws_elasticache_cluster: "elasticache",
  aws_elasticache_replication_group: "elasticache",
  // security / identity
  aws_iam_role: "iam-role",
  aws_iam_instance_profile: "iam-role",
  aws_iam_user: "iam",
  aws_iam_policy: "iam",
  aws_iam_group: "iam",
  aws_kms_key: "kms",
  aws_kms_alias: "kms",
  aws_secretsmanager_secret: "secrets-manager",
  aws_acm_certificate: "certificate-manager",
  aws_wafv2_web_acl: "waf",
  aws_cognito_user_pool: "cognito",
  // messaging
  aws_sqs_queue: "sqs",
  aws_sns_topic: "sns",
  aws_cloudwatch_event_rule: "eventbridge",
  aws_cloudwatch_event_bus: "eventbridge",
  aws_sfn_state_machine: "step-functions",
  // observability
  aws_cloudwatch_log_group: "cloudwatch",
  aws_cloudwatch_metric_alarm: "cloudwatch",
  aws_cloudwatch_dashboard: "cloudwatch",
};

/** Type-prefix → icon heuristic. Longest prefix wins (resolver sorts these). */
export const AWS_PREFIX_MAP: Record<string, AwsIconKey> = {
  aws_spot_instance: "ec2",
  aws_instance: "ec2",
  aws_launch: "ec2",
  aws_autoscaling: "ec2-auto-scaling",
  aws_lambda: "lambda",
  aws_ecs: "ecs",
  aws_eks: "eks",
  aws_ecr: "ecr",
  aws_vpc: "vpc",
  aws_subnet: "vpc",
  aws_route_table: "vpc",
  aws_security_group: "vpc",
  aws_route53: "route-53",
  aws_route: "vpc",
  aws_lb: "elb",
  aws_alb: "elb",
  aws_elb: "elb",
  aws_cloudfront: "cloudfront",
  aws_internet_gateway: "internet-gateway",
  aws_nat_gateway: "nat-gateway",
  aws_network_interface: "network-interface",
  aws_api_gateway: "api-gateway",
  aws_apigatewayv2: "api-gateway",
  aws_s3: "s3",
  aws_ebs: "ebs",
  aws_efs: "efs",
  aws_db: "rds",
  aws_rds: "aurora",
  aws_dynamodb: "dynamodb",
  aws_elasticache: "elasticache",
  aws_iam_role: "iam-role",
  aws_iam_instance_profile: "iam-role",
  aws_iam: "iam",
  aws_kms: "kms",
  aws_secretsmanager: "secrets-manager",
  aws_acm: "certificate-manager",
  aws_wafv2: "waf",
  aws_waf: "waf",
  aws_cognito: "cognito",
  aws_sqs: "sqs",
  aws_sns: "sns",
  aws_cloudwatch_event: "eventbridge",
  aws_sfn: "step-functions",
  aws_cloudwatch: "cloudwatch",
};
