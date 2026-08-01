/**
 * The thin bar under the diagram: what the diff is measured against, whether
 * the panel is caught up, and the one notice worth showing. All of it used to
 * float over the drawing, or not exist at all.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { StatusBar } from "./status-bar";

function renderBar(
  overrides: Partial<React.ComponentProps<typeof StatusBar>> = {},
) {
  render(
    <StatusBar sync={{ value: "synced" }} base={null} notice={null} {...overrides} />,
  );
}

describe("what the diff is measured against", () => {
  test("names the ref and the commit", () => {
    renderBar({ base: { ref: "origin/main", sha: "a1b2c3d4e5f6" } });

    expect(screen.getByText("origin/main")).toBeInTheDocument();
    expect(screen.getByText("a1b2c3d")).toBeInTheDocument();
  });

  test("a baseline with no commit named still names the ref", () => {
    renderBar({ base: { ref: "HEAD", sha: null } });

    expect(screen.getByText("HEAD")).toBeInTheDocument();
  });

  test("with no diff running there is nothing to measure against", () => {
    renderBar({ base: null });

    expect(screen.queryByText(/origin\/main/)).not.toBeInTheDocument();
  });
});

describe("sync state", () => {
  test("says when it is still working", () => {
    renderBar({ sync: { value: "rendering" } });

    expect(screen.getByText(/rendering/i)).toBeInTheDocument();
  });

  test("says when it has caught up", () => {
    renderBar({ sync: { value: "synced" } });

    expect(screen.getByText(/synced/i)).toBeInTheDocument();
  });

  test("an error says what went wrong rather than just that it did", () => {
    renderBar({ sync: { value: "error", message: "unbalanced braces" } });

    expect(screen.getByText(/unbalanced braces/i)).toBeInTheDocument();
  });

  test("the state is announced, not just coloured", () => {
    // A dot that changes colour tells a screen reader nothing, and tells a
    // reader who cannot separate the two colours nothing either.
    renderBar({ sync: { value: "rendering" } });

    expect(screen.getByRole("status")).toHaveTextContent(/rendering/i);
  });
});

describe("the notice slot", () => {
  test("shows the notice it was given", () => {
    renderBar({
      notice: { kind: "out-of-sync", text: "Out of sync — last good parse", warn: true },
    });

    expect(screen.getByText(/out of sync/i)).toBeInTheDocument();
  });

  test("stays empty when there is nothing to report", () => {
    renderBar({ notice: null });

    expect(screen.queryByText(/out of sync/i)).not.toBeInTheDocument();
  });
});

describe("the caveat on demand", () => {
  test("opens the same explanation the diff popover carries", () => {
    const onAbout = vi.fn();
    render(
      <StatusBar
        sync={{ value: "synced" }}
        base={{ ref: "origin/main", sha: "a1b2c3d4" }}
        notice={null}
        onAbout={onAbout}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /about this diff/i }));

    expect(onAbout).toHaveBeenCalled();
  });

  test("there is nothing to explain when no diff is running", () => {
    renderBar({ base: null });

    expect(
      screen.queryByRole("button", { name: /about this diff/i }),
    ).not.toBeInTheDocument();
  });
});
