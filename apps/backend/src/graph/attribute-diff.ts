/**
 * GP-32: compute a per-node before/after attribute diff from a plan
 * `resource_change.change`. Pure function — plan change in, rows out; no I/O.
 *
 * Two hard rules the render layer downstream relies on:
 *  - **Sensitive values never leak.** A key flagged sensitive on either side is
 *    masked as `(sensitive)` on both sides — the raw value is never rendered.
 *  - **Nested structures are never dumped.** Objects/arrays collapse to the
 *    `{…}` deep-change marker; we surface *that* an attribute changed, not the
 *    (potentially huge, potentially secret-bearing) contents.
 *
 * Keys are sorted ascending and rows are capped so the output is deterministic
 * and bounded — the graph is serialized byte-stably for golden comparison.
 */
import type { ChangeKind } from "./graph.js";

/** One masked before/after row for a single attribute. */
export type AttributeDiffRow = {
  key: string;
  before: string | null;
  after: string | null;
};

/** The `change` object of a Terraform plan `resource_change` (fields optional). */
export type PlanResourceChange = {
  before?: unknown;
  after?: unknown;
  after_unknown?: unknown;
  before_sensitive?: unknown;
  after_sensitive?: unknown;
};

/** At most this many changed attributes are kept; the rest are truncated. */
const MAX_ROWS = 20;
/** Rendered scalar values longer than this are sliced with a trailing ellipsis. */
const MAX_VALUE_LENGTH = 200;
/** Marker for a nested change — we never render the structure itself. */
const DEEP_MARKER = "{…}";

const compareStrings = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Only real objects (not arrays, not null) carry per-key flag maps. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Order-sensitive deep equality — cheap and sufficient for change detection. */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Render a raw attribute value for display: scalars verbatim, everything else
 * collapsed to the deep-change marker (NEVER the nested contents). The result
 * is then truncated to a bounded length.
 */
export function render(value: unknown): string {
  let out: string;
  if (typeof value === "string") out = value;
  else if (value === null) out = "null";
  else if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    out = String(value);
  } else {
    out = DEEP_MARKER;
  }
  return out.length > MAX_VALUE_LENGTH
    ? out.slice(0, MAX_VALUE_LENGTH) + "…"
    : out;
}

/**
 * Compute the masked attribute diff for a single resource change. Returns the
 * (key-sorted, capped) rows plus whether the list was truncated at `MAX_ROWS`.
 */
export function computeAttributeDiff(
  change: PlanResourceChange | undefined,
  changeKind: ChangeKind,
): { rows: AttributeDiffRow[]; truncated: boolean } {
  if (changeKind === "noop") return { rows: [], truncated: false };

  const c = change ?? {};
  const beforeObj = asRecord(c.before);
  const afterObj = asRecord(c.after);
  const afterUnknownAll = c.after_unknown === true;
  const afterUnknownObj = asRecord(c.after_unknown);
  const sensitiveAll = c.before_sensitive === true || c.after_sensitive === true;
  const beforeSensitiveObj = asRecord(c.before_sensitive);
  const afterSensitiveObj = asRecord(c.after_sensitive);

  // Candidate keys: union of before/after keys plus after_unknown keys that are
  // truthy (a computed attribute not present in either concrete map).
  const keys = new Set<string>();
  if (beforeObj) for (const k of Object.keys(beforeObj)) keys.add(k);
  if (afterObj) for (const k of Object.keys(afterObj)) keys.add(k);
  if (afterUnknownObj) {
    for (const k of Object.keys(afterUnknownObj)) if (afterUnknownObj[k]) keys.add(k);
  }
  const sortedKeys = [...keys].sort(compareStrings);

  const rows: AttributeDiffRow[] = [];
  for (const key of sortedKeys) {
    const bRaw = beforeObj ? beforeObj[key] : undefined;
    const aRaw = afterObj ? afterObj[key] : undefined;
    const unknown = afterUnknownAll || (afterUnknownObj ? !!afterUnknownObj[key] : false);
    const sensitive =
      sensitiveAll ||
      (beforeSensitiveObj ? !!beforeSensitiveObj[key] : false) ||
      (afterSensitiveObj ? !!afterSensitiveObj[key] : false);

    let include: boolean;
    if (changeKind === "create") include = aRaw !== undefined || unknown;
    else if (changeKind === "delete") include = bRaw !== undefined;
    else include = unknown || !deepEqual(bRaw, aRaw);
    if (!include) continue;

    // Sensitive wins over everything so plaintext never reaches the row.
    const before: string | null =
      changeKind === "create"
        ? null
        : sensitive
          ? "(sensitive)"
          : bRaw === undefined
            ? null
            : render(bRaw);
    const after: string | null =
      changeKind === "delete"
        ? null
        : sensitive
          ? "(sensitive)"
          : unknown
            ? "(known after apply)"
            : aRaw === undefined
              ? null
              : render(aRaw);

    if (before === null && after === null) continue;
    rows.push({ key, before, after });
  }

  if (rows.length > MAX_ROWS) return { rows: rows.slice(0, MAX_ROWS), truncated: true };
  return { rows, truncated: false };
}
