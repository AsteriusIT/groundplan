import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

import { HclEditor } from "./hcl-editor";

const DOC = `resource "azurerm_resource_group" "demo" {
  name     = "rg-playground"
  location = "westeurope" # region
}
`;

function viewOf(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor");
  if (!dom) throw new Error("no editor mounted");
  const view = EditorView.findFromDOM(dom as HTMLElement);
  if (!view) throw new Error("no EditorView behind the DOM");
  return view;
}

it("renders the document in an accessible editor with line numbers", () => {
  const { container } = render(
    <HclEditor value={DOC} onChange={() => {}} ariaLabel="File content" />,
  );

  expect(screen.getByRole("textbox", { name: /file content/i })).toBeVisible();
  expect(viewOf(container).state.doc.toString()).toBe(DOC);
  // The line-number gutter shows a number per line.
  const gutter = container.querySelector(".cm-lineNumbers");
  expect(gutter).not.toBeNull();
  expect(gutter?.textContent).toContain("4");
});

it("does not wrap long lines (horizontal scroll instead)", () => {
  const { container } = render(
    <HclEditor value={DOC} onChange={() => {}} ariaLabel="File content" />,
  );
  expect(container.querySelector(".cm-lineWrapping")).toBeNull();
});

it("keeps the sticky line-number gutter opaque so scrolled code cannot show through it", () => {
  const { container } = render(
    <HclEditor value={DOC} onChange={() => {}} ariaLabel="File content" />,
  );

  const gutters = container.querySelector(".cm-gutters");
  expect(gutters).not.toBeNull();
  // CodeMirror keeps the gutter position:sticky while long lines scroll
  // horizontally beneath it — a transparent background lets that text bleed
  // through the line numbers.
  expect((gutters as HTMLElement).style.position).toBe("sticky");
  expect(getComputedStyle(gutters as HTMLElement).backgroundColor).toBe(
    "var(--card)",
  );
});

it("reports edits through onChange", () => {
  const onChange = vi.fn();
  const { container } = render(
    <HclEditor value="a = 1" onChange={onChange} ariaLabel="File content" />,
  );

  const view = viewOf(container);
  view.dispatch({ changes: { from: 0, to: 0, insert: "# note\n" } });

  expect(onChange).toHaveBeenCalledWith("# note\na = 1");
});

it("indents with two spaces", () => {
  const { container } = render(
    <HclEditor value="a = 1" onChange={() => {}} ariaLabel="File content" />,
  );
  const view = viewOf(container);
  expect(view.state.tabSize).toBe(2);
});

it("colours strings and comments through the shared code tokens", () => {
  const { container } = render(
    <HclEditor value={DOC} onChange={() => {}} ariaLabel="File content" />,
  );

  const strings = container.querySelectorAll(".text-code-string");
  const comments = container.querySelectorAll(".text-code-comment");
  const keywords = container.querySelectorAll(".text-code-keyword");
  expect(strings.length).toBeGreaterThan(0);
  expect(comments.length).toBeGreaterThan(0);
  // `resource` — the block identifier — is marked as a keyword.
  expect([...keywords].map((el) => el.textContent)).toContain("resource");
});

it("marks the parse-error line, and only that line", () => {
  const { container } = render(
    <HclEditor
      value={DOC}
      onChange={() => {}}
      ariaLabel="File content"
      errorLine={2}
    />,
  );

  const marked = container.querySelectorAll(".cm-error-line");
  expect(marked).toHaveLength(1);
  expect(marked[0]?.textContent).toContain("rg-playground");
});

it("clears the error mark when errorLine goes away", () => {
  const { container, rerender } = render(
    <HclEditor
      value={DOC}
      onChange={() => {}}
      ariaLabel="File content"
      errorLine={2}
    />,
  );
  expect(container.querySelector(".cm-error-line")).not.toBeNull();

  rerender(
    <HclEditor value={DOC} onChange={() => {}} ariaLabel="File content" />,
  );
  expect(container.querySelector(".cm-error-line")).toBeNull();
});

it("ignores an error line beyond the document", () => {
  const { container } = render(
    <HclEditor
      value="a = 1"
      onChange={() => {}}
      ariaLabel="File content"
      errorLine={99}
    />,
  );
  expect(container.querySelector(".cm-error-line")).toBeNull();
});

it("marks and selects the located line — the diagram's jump into code (GP-245)", () => {
  const { container } = render(
    <HclEditor
      value={DOC}
      onChange={() => {}}
      ariaLabel="File content"
      locatedLine={3}
    />,
  );

  const marked = container.querySelectorAll(".cm-located-line");
  expect(marked).toHaveLength(1);
  expect(marked[0]?.textContent).toContain("westeurope");
  // The cursor lands there too, so the keyboard carries on from the answer.
  const view = viewOf(container);
  expect(view.state.selection.main.head).toBe(view.state.doc.line(3).from);
});

it("keeps each document's cursor and history when tabs are switched (GP-245)", () => {
  const props = { onChange: () => {}, ariaLabel: "File content" };
  const { container, rerender } = render(
    <HclEditor {...props} docId="main.tf" value={DOC} />,
  );

  const view = viewOf(container);
  view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
  const parked = view.state.selection.main.head;

  rerender(<HclEditor {...props} docId="network.tf" value="a = 1" />);
  // A different document, with a cursor of its own — not the other one's.
  expect(viewOf(container).state.doc.toString()).toBe("a = 1");
  expect(viewOf(container).state.selection.main.head).toBe(0);

  rerender(<HclEditor {...props} docId="main.tf" value={DOC} />);
  expect(viewOf(container).state.doc.toString()).toBe(DOC);
  expect(viewOf(container).state.selection.main.head).toBe(parked);
  // The same EditorView throughout: switching a tab is not a remount.
  expect(viewOf(container)).toBe(view);
});

it("takes an external edit to a document that is not open", () => {
  const props = { onChange: () => {}, ariaLabel: "File content" };
  const { container, rerender } = render(
    <HclEditor {...props} docId="main.tf" value={DOC} />,
  );
  rerender(<HclEditor {...props} docId="network.tf" value="a = 1" />);
  // main.tf was replaced (an upload) while network.tf was open.
  rerender(<HclEditor {...props} docId="main.tf" value="# replaced" />);

  expect(viewOf(container).state.doc.toString()).toBe("# replaced");
});
