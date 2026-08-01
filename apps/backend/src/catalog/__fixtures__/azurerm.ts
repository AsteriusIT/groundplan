/**
 * The provider's own word, for tests that need a real schema (GP-234).
 *
 * The JSON lives in `@groundplan/builder`, beside the parser that narrows it,
 * because there is exactly one copy of it in this repository and that is where
 * it belongs. Reaching across the workspace by path is deliberate: it is a
 * development fixture, not something the package should export, and a second
 * copy here would be a second thing to keep in step with the provider.
 */
import { readFileSync } from "node:fs";

import {
  parseProviderSchema,
  type ProviderResourceSchema,
  type RawProvidersSchema,
} from "@groundplan/builder";

const FIXTURE = new URL(
  "../../../../../packages/builder/src/__fixtures__/azurerm-4.81.0-subset.json",
  import.meta.url,
);

export const AZURERM_VERSION = "4.81.0";

/** The raw `terraform providers schema -json` payload, verbatim. */
export const AZURERM_RAW = JSON.parse(
  readFileSync(FIXTURE, "utf8"),
) as RawProvidersSchema;

/** The same, narrowed — what the catalog actually stores. */
export const AZURERM_SCHEMAS: ProviderResourceSchema[] = parseProviderSchema(
  AZURERM_RAW,
  { provider: "hashicorp/azurerm", version: AZURERM_VERSION },
);
