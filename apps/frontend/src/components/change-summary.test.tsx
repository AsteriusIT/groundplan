import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ChangeSummary, ChangeSummaryPanel } from "./change-summary";

const MD = `**+2 created · −1 deleted** (3 resources)

**Deleted**
- \`aws_s3_bucket.old\`

**Created**
- Network: 2 (subnet ×2)`;

it("renders bold headings, code addresses and list items", () => {
  render(<ChangeSummary markdown={MD} />);
  // Inline **bold** becomes a <strong>.
  expect(screen.getByText("+2 created · −1 deleted")).toBeInTheDocument();
  // Inline `code` becomes a <code> element carrying the address.
  const code = screen.getByText("aws_s3_bucket.old");
  expect(code.tagName).toBe("CODE");
  // A section heading and a grouped-creation line.
  expect(screen.getByText("Deleted")).toBeInTheDocument();
  expect(screen.getByText(/Network: 2 \(subnet ×2\)/)).toBeInTheDocument();
});

it("panel collapses a no-change summary to a plain line", () => {
  render(<ChangeSummaryPanel markdown="No changes." />);
  expect(screen.getByText(/No infrastructure changes/i)).toBeInTheDocument();
  expect(screen.queryByText("Change summary")).not.toBeInTheDocument();
});

it("panel shows a collapsible section for a real summary", () => {
  render(<ChangeSummaryPanel markdown={MD} />);
  expect(screen.getByText("Change summary")).toBeInTheDocument();
  expect(screen.getByText("Deleted")).toBeInTheDocument();
});
