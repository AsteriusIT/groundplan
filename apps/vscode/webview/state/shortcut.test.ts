/**
 * What a keypress in the panel means — decided as a value, so the rules can be
 * read and argued with rather than inferred from a chain of ifs in a handler.
 *
 * Two rules matter more than the bindings themselves: never take a key from a
 * text field, and never take one the editor owns.
 */
import { describe, expect, test } from "vitest";

import { shortcutFor } from "./shortcut";

const IDLE = { typing: false, popoverOpen: false, searchOpen: false };

function press(
  key: string,
  over: Partial<Parameters<typeof shortcutFor>[0]> = {},
) {
  return shortcutFor({ key, ...IDLE, ...over });
}

describe("bindings", () => {
  test("d toggles diff mode", () => {
    expect(press("d")).toEqual({ kind: "toggleDiff" });
  });

  test("1, 2 and 3 pick a lens", () => {
    expect(press("1")).toEqual({ kind: "lens", lens: "infra" });
    expect(press("2")).toEqual({ kind: "lens", lens: "network" });
    expect(press("3")).toEqual({ kind: "lens", lens: "iam" });
  });

  test("f fits", () => {
    expect(press("f")).toEqual({ kind: "fit" });
  });

  test("/ opens search", () => {
    expect(press("/")).toEqual({ kind: "search" });
  });

  test("ctrl+f opens search, and cmd+f does too", () => {
    expect(press("f", { ctrl: true })).toEqual({ kind: "search" });
    expect(press("f", { meta: true })).toEqual({ kind: "search" });
  });

  test("a key nobody bound means nothing", () => {
    expect(press("q")).toBeNull();
  });
});

describe("escape unwinds one layer at a time", () => {
  test("an open popover closes first", () => {
    expect(press("Escape", { popoverOpen: true, searchOpen: true })).toEqual({
      kind: "closePopover",
    });
  });

  test("then the search folds away", () => {
    expect(press("Escape", { searchOpen: true })).toEqual({ kind: "closeSearch" });
  });

  test("and with nothing open it clears the selection", () => {
    expect(press("Escape")).toEqual({ kind: "clearSelection" });
  });
});

describe("what the panel must not take", () => {
  test("nothing at all while a text field has the focus", () => {
    // "d" in the search box is a letter, not a command.
    for (const key of ["d", "1", "f", "/"]) {
      expect(press(key, { typing: true })).toBeNull();
    }
  });

  test("except Escape, which is how you get out of the field", () => {
    expect(press("Escape", { typing: true, searchOpen: true })).toEqual({
      kind: "closeSearch",
    });
  });

  test("nothing with a modifier the editor owns", () => {
    // Ctrl+D is "add selection to next find match"; taking it inside a
    // webview would silently break a reflex.
    expect(press("d", { ctrl: true })).toBeNull();
    expect(press("1", { meta: true })).toBeNull();
    expect(press("f", { alt: true })).toBeNull();
  });

  test("ctrl+f is the one modifier binding, because it is the same idea", () => {
    expect(press("f", { ctrl: true })).toEqual({ kind: "search" });
  });

  test("shift does not turn a letter into a command", () => {
    expect(press("D", { shift: true })).toBeNull();
  });
});
