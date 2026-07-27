import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import { DOC_PAGES, docsUrl } from "@/lib/docs";
import { DocsLink } from "./docs-link";

it("points at the documentation site and opens away from the work", () => {
  render(<DocsLink page="cli">CLI reference</DocsLink>);
  const link = screen.getByRole("link", { name: /CLI reference/ });
  expect(link).toHaveAttribute("href", "https://doc.asteriusit.fr/ci/cli/");
  // These appear beside half-filled forms and one-time tokens; navigating away
  // in place would lose the work.
  expect(link).toHaveAttribute("target", "_blank");
  // The docs site has no business knowing which instance sent somebody.
  expect(link).toHaveAttribute("rel", "noreferrer");
});

it("has no axe violations", async () => {
  const { baseElement } = render(
    <main>
      <DocsLink page="policies">Policies</DocsLink>
    </main>,
  );
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});

it("keeps every destination an absolute path on one origin", () => {
  // A relative path here would resolve against the app and 404 quietly; a
  // second origin would mean the rebranding (GP-166) has two places to change.
  for (const [name, path] of Object.entries(DOC_PAGES)) {
    expect(path, name).toMatch(/^\/([\w-]+\/)*$/);
    expect(docsUrl(name as keyof typeof DOC_PAGES)).toBe(
      `https://doc.asteriusit.fr${path}`,
    );
  }
});
