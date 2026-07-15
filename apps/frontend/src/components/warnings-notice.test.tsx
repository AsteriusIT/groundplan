import { expect, it, describe } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { WarningsNotice } from "./warnings-notice";

describe("WarningsNotice unresolved-references surface", () => {
  it("renders nothing when there is neither a warning nor an unresolved ref", () => {
    const { container } = render(
      <WarningsNotice warnings={[]} unresolvedReferences={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a link that opens a dialog listing each unresolved reference", () => {
    render(
      <WarningsNotice
        warnings={[]}
        unresolvedReferences={[
          {
            from: "aws_s3_bucket.logs",
            ref: "aws_kms_key.missing",
            reason: "no matching resource, data source, or module",
          },
          {
            from: "payments/Deployment/api",
            ref: "payments/ConfigMap/settings",
            reason: "no ConfigMap 'settings' in this namespace",
          },
        ]}
      />,
    );

    // The message is a link — the count, phrased for a reader.
    const link = screen.getByText(/2 references could not be resolved/i);
    // The list is behind the link, not spilled into the banner.
    expect(screen.queryByText("aws_kms_key.missing")).not.toBeInTheDocument();

    fireEvent.click(link);

    // Both references, their targets, and their reasons are now readable.
    expect(screen.getByText("aws_s3_bucket.logs")).toBeInTheDocument();
    expect(screen.getByText("aws_kms_key.missing")).toBeInTheDocument();
    expect(screen.getByText("payments/ConfigMap/settings")).toBeInTheDocument();
    expect(
      screen.getByText("no ConfigMap 'settings' in this namespace"),
    ).toBeInTheDocument();
  });

  it("surfaces plain warnings and unresolved refs side by side", () => {
    render(
      <WarningsNotice
        warnings={["skipped a.tf: bad block"]}
        unresolvedReferences={[
          { from: "a", ref: "b", reason: "gone" },
        ]}
      />,
    );
    expect(screen.getByText("skipped a.tf: bad block")).toBeInTheDocument();
    expect(
      screen.getByText(/1 reference could not be resolved/i),
    ).toBeInTheDocument();
  });
});
