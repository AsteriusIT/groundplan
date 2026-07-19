resource "aws_vpc" "this" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_flow_log" "this" {
  # Expression reference (aws_vpc.this.id) is intentionally NOT turned into an
  # edge — only explicit depends_on is (GP-15: no expression evaluation).
  vpc_id     = aws_vpc.this.id
  depends_on = [aws_vpc.this]
}
