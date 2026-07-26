resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/shop/${local.name}"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.main.arn

  tags = local.tags
}

resource "aws_sns_topic" "alerts" {
  name              = "alerts-${local.name}"
  kms_master_key_id = aws_kms_key.main.id

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "unhealthy-hosts-${local.name}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    TargetGroup  = aws_lb_target_group.app.arn_suffix
    LoadBalancer = aws_lb.main.arn_suffix
  }

  tags = local.tags
}
