/**
 * The status bar's notice slot holds one thing at a time. Three conditions can
 * want it, and stacking them was what the old panel did — a banner across the
 * top, a chip in the corner and a pill in the middle, all at once, over the
 * diagram they were describing.
 */
import { describe, expect, test } from "vitest";

import { NO_DIFF_FACTS } from "./panel-state";
import { statusNotice } from "./status-notice";

const QUIET = {
  diffEnabled: false,
  facts: NO_DIFF_FACTS,
  outOfSync: false,
  multiRoot: false,
  folder: "infra",
};

describe("statusNotice", () => {
  test("says nothing when there is nothing to say", () => {
    expect(statusNotice(QUIET)).toBeNull();
  });

  test("names the folder being previewed when others were ignored", () => {
    const notice = statusNotice({ ...QUIET, multiRoot: true });

    expect(notice?.kind).toBe("multi-root");
    expect(notice?.text).toContain("infra");
  });

  test("a stale diagram outranks a multi-root workspace", () => {
    // One is about which folder; the other is that what you are looking at is
    // not what you wrote. The second is the one worth the slot.
    const notice = statusNotice({ ...QUIET, multiRoot: true, outOfSync: true });

    expect(notice?.kind).toBe("out-of-sync");
  });

  test("a diff that could not run outranks everything", () => {
    const notice = statusNotice({
      diffEnabled: true,
      facts: {
        available: false,
        ref: null,
        sha: null,
        reason: "no commits yet",
        clean: false,
      },
      outOfSync: true,
      multiRoot: true,
      folder: "infra",
    });

    expect(notice?.kind).toBe("diff-unavailable");
    expect(notice?.text).toContain("no commits yet");
  });

  test("an unresolved baseline is only news while diff mode is on", () => {
    const notice = statusNotice({
      ...QUIET,
      facts: {
        available: false,
        ref: null,
        sha: null,
        reason: "no commits yet",
        clean: false,
      },
    });

    expect(notice).toBeNull();
  });

  test("a resolved baseline is not a notice", () => {
    const notice = statusNotice({
      ...QUIET,
      diffEnabled: true,
      facts: {
        available: true,
        ref: "origin/main",
        sha: "a1b2c3d",
        reason: null,
        clean: false,
      },
    });

    expect(notice).toBeNull();
  });
});
