import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ContextSection } from "./context-section";

const noop = () => {};

it("renders the markdown when present", () => {
  render(<ContextSection markdown={"# Payments\n\nOwns **billing**."} onSave={noop} />);
  expect(screen.getByText(/Owns/)).toBeInTheDocument();
});

it("invites writing when empty and editable (no lorem ipsum)", () => {
  render(<ContextSection markdown={null} onSave={noop} />);
  expect(screen.getByText(/describe this infrastructure/i)).toBeInTheDocument();
});

it("renders nothing when empty and read-only", () => {
  const { container } = render(<ContextSection markdown="" readOnly />);
  expect(container).toBeEmptyDOMElement();
});

it("has no edit affordance when read-only", () => {
  render(<ContextSection markdown="something" readOnly />);
  expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
});

it("edits and saves the context", () => {
  const onSave = vi.fn();
  render(<ContextSection markdown={"old"} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /edit/i }));
  const textarea = screen.getByLabelText(/context/i);
  expect(textarea).toHaveValue("old");
  fireEvent.change(textarea, { target: { value: "new context" } });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));
  expect(onSave).toHaveBeenCalledWith("new context");
});

it("enters edit from the empty state", () => {
  const onSave = vi.fn();
  render(<ContextSection markdown={null} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /describe this infrastructure/i }));
  fireEvent.change(screen.getByLabelText(/context/i), { target: { value: "first" } });
  fireEvent.click(screen.getByRole("button", { name: /save/i }));
  expect(onSave).toHaveBeenCalledWith("first");
});
