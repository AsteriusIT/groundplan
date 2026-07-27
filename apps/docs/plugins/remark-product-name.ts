import { visit } from "unist-util-visit";

import { PRODUCT } from "../src/product.js";

/**
 * Substitute `%PRODUCT%` with the product name (GP-213).
 *
 * The trademark gate (GP-166) is open, so the name has to be replaceable in one
 * edit. Text nodes only — a code block that says `groundplan push-plan` is a
 * command somebody's pipeline runs, not a brand, and must survive a rename
 * untouched. Titles and descriptions go through `substituteProduct` from the
 * Astro config instead, since frontmatter never reaches a remark plugin as text.
 */
export function substituteProduct(value: string): string {
  return value.split("%PRODUCT%").join(PRODUCT);
}

type Textish = { type: string; value: string };

export function remarkProductName() {
  return (tree: unknown): void => {
    visit(tree as never, (node: Textish) => {
      if (node.type === "text" || node.type === "html") {
        node.value = substituteProduct(node.value);
      }
    });
  };
}

export default remarkProductName;
