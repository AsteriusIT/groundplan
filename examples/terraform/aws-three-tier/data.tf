# The data tier and the key that protects it. `storage_encrypted = true` and
# `encrypted = true` are written out rather than left to the default - the
# `encryption-at-rest-disabled` rule only ever objects to an explicit `false`,
# so being explicit costs nothing and reads better in review.

resource "aws_kms_key" "main" {
  description             = "Shop data at rest"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = local.tags
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main.key_id
}

resource "aws_s3_bucket" "assets" {
  bucket = "${local.name}-assets"

  tags = local.tags
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.main.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_db_subnet_group" "main" {
  name       = "dbsubnet-${local.name}"
  subnet_ids = aws_subnet.private[*].id

  tags = local.tags
}

# The password is generated and stored, never written here: nothing in this file
# would give `hardcoded-secret` anything to find.
resource "aws_secretsmanager_secret" "db" {
  name       = "${local.name}/db/master"
  kms_key_id = aws_kms_key.main.arn

  tags = local.tags
}

resource "aws_db_instance" "main" {
  identifier                    = "db-${local.name}"
  engine                        = "postgres"
  engine_version                = "16"
  instance_class                = "db.t4g.medium"
  allocated_storage             = 100
  storage_encrypted             = true
  kms_key_id                    = aws_kms_key.main.arn
  db_subnet_group_name          = aws_db_subnet_group.main.name
  vpc_security_group_ids        = [aws_security_group.db.id]
  publicly_accessible           = false
  multi_az                      = true
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.main.arn
  username                      = "shopadmin"
  skip_final_snapshot           = false
  final_snapshot_identifier     = "db-${local.name}-final"

  tags = local.tags
}

resource "aws_dynamodb_table" "sessions" {
  name         = "sessions-${local.name}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "session_id"

  attribute {
    name = "session_id"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.main.arn
  }

  tags = local.tags
}
