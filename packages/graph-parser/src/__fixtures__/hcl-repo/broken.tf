# Intentionally malformed: the resource block is never closed. The parser must
# skip this file with a warning and still succeed on the rest of the repo.
resource "aws_thing" "broken" {
  name = "oops"
