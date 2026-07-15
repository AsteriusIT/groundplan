/**
 * Terraform address format validation (GP-56).
 *
 * Annotations anchor to Terraform addresses (a graph node's `id`, e.g.
 * `module.payments.aws_ecs_service.this`). We validate the *format* only —
 * whether the referenced resource actually exists is decided by reconciliation
 * (GP-57) against a snapshot, never here.
 *
 * An address is two or more dot-separated segments. Each segment is an
 * identifier (`aws_s3_bucket`, `module`, `data`, a name) optionally followed by
 * a `[index]` suffix for `count`/`for_each` instances (`web[0]`, `web["key"]`).
 */
const SEGMENT = String.raw`[A-Za-z_][A-Za-z0-9_-]*(?:\[[^\]\s]+\])?`;
const ADDRESS = new RegExp(String.raw`^${SEGMENT}(?:\.${SEGMENT})+$`);

/** True when `value` looks like a Terraform resource address (format only). */
export function isTerraformAddress(value: string): boolean {
  return ADDRESS.test(value);
}
