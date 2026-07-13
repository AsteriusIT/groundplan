import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { Annotation, Graph } from "@/api/types";
import { OrphanReview } from "./orphan-review";

function ann(partial: Partial<Annotation> & Pick<Annotation, "id" | "type" | "anchors">): Annotation {
  return {
    repositoryId: "r",
    label: null,
    body: null,
    status: "orphaned",
    provenance: "human" as const,
    createdFromSha: null,
    parentGroupId: null,
    missingAnchors: [],
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const graph: Graph = {
  version: 1,
  nodes: [
    { id: "aws_s3_bucket.renamed", name: "renamed", type: "aws_s3_bucket", provider: "aws", module_path: [], change: null },
    { id: "aws_s3_bucket.other", name: "other", type: "aws_s3_bucket", provider: "aws", module_path: [], change: null },
  ],
  edges: [],
};

const noop = () => {};

it("renders nothing when there are no orphans", () => {
  const { container } = render(
    <OrphanReview orphans={[]} graph={graph} onReanchor={noop} onDelete={noop} />,
  );
  expect(container).toBeEmptyDOMElement();
});

it("shows a banner counting orphans and lists the missing address", () => {
  const note = ann({ id: "n1", type: "note", anchors: ["aws_s3_bucket.data"], body: "owner" });
  render(
    <OrphanReview
      orphans={[{ annotation: note, missing: ["aws_s3_bucket.data"] }]}
      graph={graph}
      onReanchor={noop}
      onDelete={noop}
    />,
  );
  expect(screen.getByText(/1 annotation lost its anchor/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /lost its anchor/i }));
  expect(screen.getByText("aws_s3_bucket.data")).toBeInTheDocument();
});

it("pluralizes the banner for multiple orphans", () => {
  const a = ann({ id: "a", type: "note", anchors: ["x"] });
  const b = ann({ id: "b", type: "note", anchors: ["y"] });
  render(
    <OrphanReview
      orphans={[{ annotation: a, missing: ["x"] }, { annotation: b, missing: ["y"] }]}
      graph={graph}
      onReanchor={noop}
      onDelete={noop}
    />,
  );
  expect(screen.getByText(/2 annotations lost their anchor/i)).toBeInTheDocument();
});

it("deletes an orphan", () => {
  const onDelete = vi.fn();
  const note = ann({ id: "n1", type: "note", anchors: ["aws_s3_bucket.data"] });
  render(
    <OrphanReview
      orphans={[{ annotation: note, missing: ["aws_s3_bucket.data"] }]}
      graph={graph}
      onReanchor={noop}
      onDelete={onDelete}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /lost its anchor/i }));
  fireEvent.click(screen.getByRole("button", { name: /delete/i }));
  expect(onDelete).toHaveBeenCalledWith("n1");
});

it("re-anchors an orphan by searching the current snapshot's addresses", () => {
  const onReanchor = vi.fn();
  const note = ann({ id: "n1", type: "note", anchors: ["aws_s3_bucket.data"] });
  render(
    <OrphanReview
      orphans={[{ annotation: note, missing: ["aws_s3_bucket.data"] }]}
      graph={graph}
      onReanchor={onReanchor}
      onDelete={noop}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /lost its anchor/i }));
  fireEvent.click(screen.getByRole("button", { name: /re-anchor/i }));
  fireEvent.change(screen.getByLabelText(/search resources/i), {
    target: { value: "renamed" },
  });
  fireEvent.click(screen.getByRole("button", { name: /aws_s3_bucket\.renamed/ }));
  // The missing anchor is replaced with the chosen address.
  expect(onReanchor).toHaveBeenCalledWith("n1", ["aws_s3_bucket.renamed"]);
});
