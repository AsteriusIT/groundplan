/**
 * Everything about the diff that is not "is it on": which baseline, whether to
 * fold to the changed set, and what a static diff actually is. It lives behind
 * the split-button's chevron because none of it is worth permanent screen
 * space — the old panel spent a banner and a pill on it, forever.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { NO_DIFF_FACTS, type DiffFacts, type DiffPrefs } from "../state/panel-state";
import { DiffPopover } from "./diff-popover";

const OFF: DiffPrefs = { enabled: false, mode: "head", changedOnly: false };
const ON: DiffPrefs = { enabled: true, mode: "merge-base", changedOnly: false };
const RESOLVED: DiffFacts = {
  available: true,
  ref: "origin/main",
  reason: null,
  clean: false,
};

function renderPopover(
  overrides: Partial<React.ComponentProps<typeof DiffPopover>> = {},
) {
  const onAction = vi.fn();
  const onClose = vi.fn();
  render(
    <div>
      <button type="button">outside</button>
      <DiffPopover
        open
        onClose={onClose}
        prefs={ON}
        facts={RESOLVED}
        onAction={onAction}
        {...overrides}
      />
    </div>,
  );
  return { onAction, onClose };
}

describe("opening and closing", () => {
  test("closed, it is not in the document at all", () => {
    renderPopover({ open: false });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("Escape closes it", () => {
    const { onClose } = renderPopover();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  test("clicking outside closes it", () => {
    const { onClose } = renderPopover();

    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));

    expect(onClose).toHaveBeenCalled();
  });

  test("clicking inside leaves it open", () => {
    const { onClose } = renderPopover();

    fireEvent.mouseDown(screen.getByRole("dialog"));

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("baseline", () => {
  test("offers the two baselines that exist, with the current one selected", () => {
    // There are exactly two: `head` and `merge-base`. `merge-base` *is*
    // "vs main" — a third option would be an invention.
    renderPopover();

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /main/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /head/i })).not.toBeChecked();
  });

  test("picking a baseline asks for it", () => {
    const { onAction } = renderPopover();

    fireEvent.click(screen.getByRole("radio", { name: /head/i }));

    expect(onAction).toHaveBeenCalledWith({ type: "setBase", mode: "head" });
  });
});

describe("changed only", () => {
  test("folds the graph when diff mode is on", () => {
    const { onAction } = renderPopover();

    fireEvent.click(screen.getByRole("checkbox", { name: /changed only/i }));

    expect(onAction).toHaveBeenCalledWith({ type: "toggleChangedOnly" });
  });

  test("is unreachable while diff mode is off", () => {
    // With no diff there is nothing to fold. The old toolbar offered it
    // anyway, which is how a control ends up meaning nothing.
    //
    // `disabled` is the whole guarantee at this level, and it is asserted
    // rather than clicked on purpose: `fireEvent.click` dispatches straight at
    // the node, so it fires on a disabled input that no user could reach. The
    // refusal itself is the reducer's, and panel-state.test.ts proves it.
    renderPopover({ prefs: OFF, facts: NO_DIFF_FACTS });

    expect(screen.getByRole("checkbox", { name: /changed only/i })).toBeDisabled();
  });

  test("it is disabled, not hidden — a vanished control teaches nothing", () => {
    renderPopover({ prefs: OFF, facts: NO_DIFF_FACTS });

    expect(screen.getByRole("checkbox", { name: /changed only/i })).toBeInTheDocument();
  });
});

describe("honest framing", () => {
  test("says a static diff is not a plan", () => {
    renderPopover();

    expect(screen.getByText(/not a Terraform plan/i)).toBeInTheDocument();
    expect(screen.getByText(/no state/i)).toBeInTheDocument();
  });

  test("an unresolved baseline explains itself here", () => {
    renderPopover({
      prefs: ON,
      facts: { available: false, ref: null, reason: "no commits yet", clean: false },
    });

    expect(screen.getByText(/no commits yet/i)).toBeInTheDocument();
  });
});
