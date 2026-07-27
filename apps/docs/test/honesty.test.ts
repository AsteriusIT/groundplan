import { describe, expect, it } from "vitest";

import { pages, sources, text } from "./helpers.js";

/**
 * The honesty gate (GP-213) — the same idea as the tests that pin the marketing
 * site's copy, pointed at the claims instead of the wording.
 *
 * §13 of `docs/website-presentation.md` lists what the product may not claim.
 * A documentation site is where an overclaim does the most damage: somebody
 * installs on the strength of it. So the list is executable, and the build
 * fails rather than the trust.
 *
 * Scanning is **per sentence, negations excluded**. "There is no cost
 * estimation" and "we never read your state" are exactly the sentences this
 * site is obliged to contain; a naive substring match would ban the honesty it
 * is supposed to enforce.
 */

const NEGATED = /\b(never|no|not|nor|cannot|can't|without|neither|none|nothing)\b/i;

function sentences(body: string): string[] {
  return body.split(/(?<=[.;:!?])\s+|\n+/);
}

/** Claims that are false however they are phrased. */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  {
    pattern: /\bcost estimat(e|es|ion|ing)\b|\bestimated cost\b|\bmonthly cost\b/i,
    why: "nothing in the product prices resources (GP-78 is not implemented)",
  },
  {
    pattern: /\bcost-aware\b|\bFinOps\b|\bInfracost\b|\bprices your\b/i,
    why: "the cost epic is not implemented; do not name it as a feature",
  },
  {
    pattern: /\b(emailed|e-mailed|email(s|ed)? (the |an |your )?invit)/i,
    why: "there is no SMTP anywhere: invitations are copy-the-link",
  },
  {
    pattern: /\b(SOC ?2|ISO ?27001|HIPAA|PCI[- ]DSS)\b|\bcertified\b/i,
    why: "no certification exists; claiming one is a lie with legal weight",
  },
  {
    pattern: /\bwe run (terraform|helm|kustomize)\b|\bruns? (helm|kustomize) for you\b/i,
    why: "the product never executes terraform, helm or kustomize",
  },
  {
    pattern: /\bVisual Builder\b/i,
    why: "GP-131 is not implemented",
  },
  {
    pattern: /\bcloud credentials? (are|is) (stored|held|required)\b/i,
    why: "the product holds no cloud credential, ever",
  },
];

/**
 * A claim and the caveat that must sit on the same page. The caveat is a regex
 * because the wording belongs to the writer; only the fact is fixed.
 */
const CONDITIONAL: { claim: RegExp; requires: RegExp; why: string }[] = [
  {
    claim: /\bAI Studio\b/,
    requires: /\bexperimental\b/i,
    why: "the AI Studio is experimental and must say so wherever it is named",
  },
  {
    claim: /\bAI Studio\b/,
    requires: /\bAzure\b/,
    why: "the AI Studio is Azure-only and must say so wherever it is named",
  },
  {
    claim: /\b(network lens|IAM lens|Network view|IAM view)\b/i,
    requires: /Azure-first|azurerm/i,
    why: "deep network/IAM semantics are Azure-first — never promise them for AWS/GCP",
  },
];

describe("honesty (GP-213)", () => {
  it("never claims a feature the product does not have", () => {
    const offences: string[] = [];
    for (const page of pages()) {
      for (const sentence of sentences(text(page.html))) {
        if (NEGATED.test(sentence)) continue;
        for (const { pattern, why } of FORBIDDEN) {
          const hit = sentence.match(pattern);
          if (hit) offences.push(`${page.file}: "${hit[0]}" — ${why}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("keeps every caveat on the page that makes the claim", () => {
    const offences: string[] = [];
    for (const page of pages()) {
      const body = text(page.html);
      for (const { claim, requires, why } of CONDITIONAL) {
        if (claim.test(body) && !requires.test(body)) {
          offences.push(`${page.file}: ${why}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("writes the product name through the constant, never by hand", () => {
    // A rebrand (GP-166) is a one-line change only if no page hardcodes the
    // name. Code blocks are exempt: `GROUNDPLAN_TOKEN` and `@asteriusit/cli`
    // are wire contracts and package names, not branding.
    const offences: string[] = [];
    for (const { file, body } of sources()) {
      const prose = body
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`]*`/g, " ")
        .replace(/^import .*$/gm, " ");
      const hit = prose.match(/\bGroundplan\b/);
      if (hit) offences.push(`${file}: write %PRODUCT%, not "${hit[0]}"`);
    }
    expect(offences).toEqual([]);
  });
});
