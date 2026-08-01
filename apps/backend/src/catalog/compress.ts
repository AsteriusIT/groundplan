/**
 * How a provider schema is stored (GP-234): gzip of its canonical JSON.
 *
 * Deterministic on purpose — the same schema always produces the same bytes, so
 * re-extracting a provider version that has not changed writes identical rows
 * and a bundled snapshot (GP-239) can be checksummed. `zlib`'s default level is
 * fixed by the library, and the JSON is produced by the parser, which sorts
 * everything by name; nothing here depends on a clock, a locale or a map order.
 */
import { gunzipSync, gzipSync } from "node:zlib";

import type { ProviderResourceSchema } from "@groundplan/builder";

/**
 * The bytes a schema is stored as, and the size it had before compression —
 * which is what makes a payload budget checkable without decompressing.
 */
export function packSchema(schema: ProviderResourceSchema): {
  bytes: Buffer;
  rawBytes: number;
} {
  const json = JSON.stringify(schema);
  return {
    // Node's gzip header carries a zero mtime (it never calls
    // `deflateSetHeader`), so the same JSON always compresses to the same
    // bytes — which `compress.test.ts` pins, since it is a property of the
    // runtime rather than of this code.
    bytes: gzipSync(Buffer.from(json, "utf8")),
    rawBytes: Buffer.byteLength(json, "utf8"),
  };
}

/** The schema those bytes stand for. Throws if they are not a gzipped schema. */
export function unpackSchema(bytes: Buffer): ProviderResourceSchema {
  return JSON.parse(
    gunzipSync(bytes).toString("utf8"),
  ) as ProviderResourceSchema;
}
