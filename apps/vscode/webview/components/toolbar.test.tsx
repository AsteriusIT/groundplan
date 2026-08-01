/**
 * The toolbar: which lens, and what the diff is doing. Two ideas, dressed
 * differently on purpose — switching a lens and turning a tool on are not the
 * same gesture, and eight same-weight controls in a row is what the old
 * toolbar got wrong.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { NO_DIFF_FACTS, type DiffFacts, type DiffPrefs } from "../state/panel-state";
import { Toolbar } from "./toolbar";

const OFF: DiffPrefs = { enabled: false, mode: "head", changedOnly: false };
const ON: DiffPrefs = { enabled: true, mode: "merge-base", changedOnly: false };
const RESOLVED: DiffFacts = {
  available: true,
  ref: "origin/main",
  sha: "a1b2c3d4e5f6",
  reason: null,
  clean: false,
};

function renderToolbar(
  overrides: Partial<React.ComponentProps<typeof Toolbar>> = {},
) {
  const onAction = vi.fn();
  render(
    <Toolbar
      lens="infra"
      prefs={OFF}
      facts={NO_DIFF_FACTS}
      counts={null}
      onAction={onAction}
      {...overrides}
    />,
  );
  return { onAction };
}

describe("lens segments", () => {
  test("offers the three lenses with the current one selected", () => {
    renderToolbar({ lens: "network" });

    const group = screen.getByRole("radiogroup", { name: /view/i });
    expect(within(group).getByRole("radio", { name: "Global" })).not.toBeChecked();
    expect(within(group).getByRole("radio", { name: "Network" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "IAM" })).toBeChecked;
  });

  test("clicking a segment switches lens", () => {
    const { onAction } = renderToolbar();

    fireEvent.click(screen.getByRole("radio", { name: "IAM" }));

    expect(onAction).toHaveBeenCalledWith({ type: "setLens", lens: "iam" });
  });

  test("arrow keys move along the segments", () => {
    const { onAction } = renderToolbar({ lens: "infra" });

    fireEvent.keyDown(screen.getByRole("radio", { name: "Global" }), {
      key: "ArrowRight",
    });

    expect(onAction).toHaveBeenCalledWith({ type: "setLens", lens: "network" });
  });

  test("arrow keys wrap around rather than dead-ending", () => {
    const { onAction } = renderToolbar({ lens: "infra" });

    fireEvent.keyDown(screen.getByRole("radio", { name: "Global" }), {
      key: "ArrowLeft",
    });

    expect(onAction).toHaveBeenCalledWith({ type: "setLens", lens: "iam" });
  });
});

describe("diff split-button", () => {
  test("off, it says only what it is", () => {
    renderToolbar();

    const button = screen.getByRole("button", { name: /^diff$/i });
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  test("clicking the main region toggles diff mode", () => {
    const { onAction } = renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: /^diff$/i }));

    expect(onAction).toHaveBeenCalledWith({ type: "toggleDiff" });
  });

  test("on, it names the baseline it is comparing against", () => {
    renderToolbar({
      prefs: ON,
      facts: RESOLVED,
      counts: { created: 1, updated: 0, deleted: 0, impacted: 0, total: 1 },
    });

    expect(screen.getByRole("button", { name: /diff vs main/i })).toBeInTheDocument();
  });

  test("a clean diff reads as clean, not as three zeroes", () => {
    renderToolbar({
      prefs: ON,
      facts: { ...RESOLVED, clean: true },
      counts: { created: 0, updated: 0, deleted: 0, impacted: 0, total: 0 },
    });

    expect(screen.getByLabelText("No changes")).toBeInTheDocument();
    expect(screen.queryByText("+0")).not.toBeInTheDocument();
    expect(screen.queryByText("~0")).not.toBeInTheDocument();
    expect(screen.queryByText("−0")).not.toBeInTheDocument();
  });

  test("counters print the change set", () => {
    renderToolbar({
      prefs: ON,
      facts: RESOLVED,
      counts: { created: 3, updated: 1, deleted: 2, impacted: 4, total: 6 },
    });

    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByText("~1")).toBeInTheDocument();
    expect(screen.getByText("−2")).toBeInTheDocument();
  });

  test("a kind with nothing in it is not printed at all", () => {
    renderToolbar({
      prefs: ON,
      facts: RESOLVED,
      counts: { created: 0, updated: 2, deleted: 0, impacted: 0, total: 2 },
    });

    expect(screen.getByText("~2")).toBeInTheDocument();
    expect(screen.queryByText("+0")).not.toBeInTheDocument();
    expect(screen.queryByText("−0")).not.toBeInTheDocument();
  });

  test("the button is announced as a sentence, not as punctuation", () => {
    // "+3 ~1 −2" read aloud is "plus three tilde one minus two". And the
    // visible parts are flex children, so a screen reader would otherwise
    // concatenate them without separators: "Diffvs main+3".
    renderToolbar({
      prefs: ON,
      facts: RESOLVED,
      counts: { created: 3, updated: 1, deleted: 2, impacted: 0, total: 6 },
    });

    expect(
      screen.getByRole("button", {
        name: "Diff vs main 3 created, 1 updated, 2 deleted",
      }),
    ).toBeInTheDocument();
  });

  test("the impacted count stays out of the button", () => {
    // It is not a change, and the button is the one number people scan.
    renderToolbar({
      prefs: ON,
      facts: RESOLVED,
      counts: { created: 1, updated: 0, deleted: 0, impacted: 9, total: 1 },
    });

    expect(screen.queryByText(/9/)).not.toBeInTheDocument();
  });

  test("no baseline is flagged on the button, not hidden", () => {
    renderToolbar({
      prefs: ON,
      facts: {
        available: false,
        ref: null,
        sha: null,
        reason: "no commits yet",
        clean: false,
      },
      counts: null,
    });

    expect(screen.getByLabelText("No baseline")).toBeInTheDocument();
  });

  test("the chevron is reachable by name", () => {
    renderToolbar();

    expect(
      screen.getByRole("button", { name: /diff options/i }),
    ).toBeInTheDocument();
  });

  test("the IAM lens has no diff controls — a table has no diagram to colour", () => {
    renderToolbar({ lens: "iam" });

    expect(screen.queryByRole("button", { name: /^diff$/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /diff options/i }),
    ).not.toBeInTheDocument();
  });
});

// --- how the toolbar narrows ----------------------------------------------
//
// The rule: a control is complete or it is replaced by its compact form. It is
// never truncated mid-word — the old toolbar's "IA…" was a label that had
// stopped being a word.

describe("narrowing", () => {
  test("wide keeps the lens segments spelled out", () => {
    renderToolbar({ tier: "wide" });

    expect(screen.getByRole("radiogroup", { name: /view/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Network" })).toBeInTheDocument();
  });

  test("medium keeps the segments — they are how you change view", () => {
    renderToolbar({ tier: "medium" });

    expect(screen.getByRole("radiogroup", { name: /view/i })).toBeInTheDocument();
  });

  test("narrow trades the segments for a dropdown, not for three squeezed labels", () => {
    renderToolbar({ tier: "narrow" });

    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /view/i })).toBeInTheDocument();
  });

  test("the dropdown switches lens like the segments did", () => {
    const { onAction } = renderToolbar({ tier: "narrow" });

    fireEvent.change(screen.getByRole("combobox", { name: /view/i }), {
      target: { value: "iam" },
    });

    expect(onAction).toHaveBeenCalledWith({ type: "setLens", lens: "iam" });
  });

  test("narrow drops the baseline name from the button, never half of it", () => {
    renderToolbar({
      tier: "narrow",
      prefs: ON,
      facts: RESOLVED,
      counts: { created: 2, updated: 0, deleted: 0, impacted: 0, total: 2 },
    });

    expect(screen.queryByText("vs main")).not.toBeInTheDocument();
    // The counts survive: they are the reason the button is worth its space.
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  test("the baseline is still reachable — it moved into the popover, not away", () => {
    renderToolbar({ tier: "narrow", prefs: ON, facts: RESOLVED, counts: null });

    expect(
      screen.getByRole("button", { name: /diff options/i }),
    ).toBeInTheDocument();
  });

  test("every lens is still reachable at 360px", () => {
    renderToolbar({ tier: "narrow" });

    const dropdown = screen.getByRole("combobox", { name: /view/i });
    expect(within(dropdown).getAllByRole("option")).toHaveLength(3);
  });
});
