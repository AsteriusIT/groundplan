# The application tier: an autoscaling group of instances behind the target
# group, wearing an instance profile that carries exactly one policy.

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}

resource "aws_iam_role" "app" {
  name = "role-app-${local.name}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })

  tags = local.tags
}

# One policy, four resources, no wildcards on the resource side. Every arn in
# here is a reference, so the diagram draws an edge from the policy to each
# thing the application is allowed to touch.
resource "aws_iam_policy" "app" {
  name        = "policy-app-${local.name}"
  description = "What the shop application may read and write"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.assets.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.db.arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.main.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.app.arn}:*"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "app" {
  role       = aws_iam_role.app.name
  policy_arn = aws_iam_policy.app.arn
}

resource "aws_iam_instance_profile" "app" {
  name = "profile-app-${local.name}"
  role = aws_iam_role.app.name
}

resource "aws_launch_template" "app" {
  name_prefix   = "lt-app-${local.name}-"
  image_id      = data.aws_ami.al2023.id
  instance_type = "t3.medium"

  iam_instance_profile {
    arn = aws_iam_instance_profile.app.arn
  }

  vpc_security_group_ids = [aws_security_group.app.id]

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size = 40
      encrypted   = true
      kms_key_id  = aws_kms_key.main.arn
    }
  }

  metadata_options {
    http_tokens = "required"
  }

  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.tags, { Name = "app-${local.name}" })
  }
}

resource "aws_autoscaling_group" "app" {
  name                = "asg-app-${local.name}"
  min_size            = 2
  max_size            = 6
  desired_capacity    = 2
  vpc_zone_identifier = aws_subnet.private[*].id
  target_group_arns   = [aws_lb_target_group.app.arn]
  health_check_type   = "ELB"

  launch_template {
    id      = aws_launch_template.app.id
    version = "$Latest"
  }
}
