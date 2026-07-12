import { expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AnnotateToggle } from "./annotate-toolbar";

it("toggles annotate mode on and off", () => {
  render(
    <MemoryRouter initialEntries={["/docs"]}>
      <AnnotateToggle />
    </MemoryRouter>,
  );
  // Starts in view mode.
  expect(screen.getByRole("button", { name: /^annotate$/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /annotate/i }));
  // Now in annotate mode.
  expect(screen.getByRole("button", { name: /done annotating/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /done annotating/i }));
  expect(screen.getByRole("button", { name: /^annotate$/i })).toBeInTheDocument();
});

it("reflects an initial ?mode=annotate url", () => {
  render(
    <MemoryRouter initialEntries={["/docs?mode=annotate"]}>
      <AnnotateToggle />
    </MemoryRouter>,
  );
  expect(screen.getByRole("button", { name: /done annotating/i })).toBeInTheDocument();
});
