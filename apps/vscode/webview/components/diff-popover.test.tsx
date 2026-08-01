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
  sha: "a1b2c3d4e5f6",
  reason: null,
  clean: false,
  defaultBranch: "origin/main",
};

function renderPopover(
  overrides: Partial<React.ComponentProps<typeof DiffPopover>> = {},
) {
  const onAction = vi.fn();
  const onClose = vi.fn();
  const onPickBranch = vi.fn();
  render(
    <div>
      <button type="button">outside</button>
      <DiffPopover
        open
        onClose={onClose}
        prefs={ON}
        facts={RESOLVED}
        onAction={onAction}
        onPickBranch={onPickBranch}
        {...overrides}
      />
    </div>,
  );
  return { onAction, onClose, onPickBranch };
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
  test("names the repository's own default branch, never a guessed one", () => {
    // The whole point: a repository whose trunk is `master` must not be
    // offered a choice labelled "main".
    renderPopover({ facts: { ...RESOLVED, defaultBranch: "master" } });

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /master/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /head/i })).not.toBeChecked();
    expect(screen.queryByRole("radio", { name: /\bmain\b/i })).not.toBeInTheDocument();
  });

  test("with no default branch detected, the row says so rather than naming one", () => {
    renderPopover({ facts: { ...NO_DIFF_FACTS, defaultBranch: null }, prefs: OFF });

    expect(screen.getByRole("radio", { name: /default branch/i })).toBeInTheDocument();
  });

  test("picking a baseline asks for it", () => {
    const { onAction } = renderPopover();

    fireEvent.click(screen.getByRole("radio", { name: /head/i }));

    expect(onAction).toHaveBeenCalledWith({ type: "setBase", mode: "head" });
  });
});

describe("choosing another branch", () => {
  const ON_BRANCH: DiffPrefs = {
    enabled: true,
    mode: "branch:refs/remotes/origin/release/2.4",
    changedOnly: false,
  };

  test("the chosen branch gets its own row, selected, named as a reader says it", () => {
    renderPopover({ prefs: ON_BRANCH });

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /origin\/release\/2\.4/ })).toBeChecked();
  });

  test("no row for a branch that is not the baseline — it is not a menu", () => {
    // The frequent toggle is HEAD vs the default branch; a remembered branch
    // would be state that can disagree with the mode for no gain.
    renderPopover({ prefs: ON });

    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  test("Branch… asks the host to pick — the webview never holds a branch list", () => {
    const onPickBranch = vi.fn();
    renderPopover({ onPickBranch });

    fireEvent.click(screen.getByRole("button", { name: /branch/i }));

    expect(onPickBranch).toHaveBeenCalled();
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
      facts: { ...NO_DIFF_FACTS, reason: "no commits yet" },
    });

    expect(screen.getByText(/no commits yet/i)).toBeInTheDocument();
  });
});
