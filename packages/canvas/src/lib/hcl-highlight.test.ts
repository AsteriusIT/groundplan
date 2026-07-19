import { describe, expect, it } from "vitest";

import { tokenizeHcl } from "./hcl-highlight";

/** The rendered text must always be the input, character for character. */
const rejoin = (code: string) =>
  tokenizeHcl(code)
    .map((t) => t.text)
    .join("");

const kindsOf = (code: string, kind: string) =>
  tokenizeHcl(code)
    .filter((t) => t.kind === kind)
    .map((t) => t.text);

describe("tokenizeHcl (GP-121)", () => {
  it("never changes the source it highlights", () => {
    const code = [
      "# a comment",
      'resource "aws_s3_bucket" "logs" {',
      '  bucket = "logs"   # trailing',
      "  count  = 2",
      "}",
      "",
    ].join("\n");
    expect(rejoin(code)).toBe(code);
  });

  it("marks block keywords but not identifiers that merely start with one", () => {
    const code = 'resource "x" "y" {\n  resource_group_name = "rg"\n}';
    expect(kindsOf(code, "keyword")).toEqual(["resource"]);
  });

  it("marks strings, numbers and comments", () => {
    const code = '# note\nname = "app"\ncount = 3\n';
    expect(kindsOf(code, "comment")).toEqual(["# note"]);
    expect(kindsOf(code, "string")).toEqual(['"app"']);
    expect(kindsOf(code, "number")).toEqual(["3"]);
  });

  it("a # inside a string is part of the string, not a comment", () => {
    const code = 'tag = "a#b"';
    expect(kindsOf(code, "string")).toEqual(['"a#b"']);
    expect(kindsOf(code, "comment")).toEqual([]);
  });

  it("a quote inside a comment does not open a string", () => {
    const code = '# he said "hi"\nname = "app"';
    expect(kindsOf(code, "comment")).toEqual(['# he said "hi"']);
    expect(kindsOf(code, "string")).toEqual(['"app"']);
  });

  it("a heredoc is one string, braces and all", () => {
    const code = 'policy = <<POLICY\n{ "Effect": "Allow" }\nPOLICY\n';
    const strings = kindsOf(code, "string");
    expect(strings).toHaveLength(1);
    expect(strings[0]).toContain('{ "Effect": "Allow" }');
    expect(rejoin(code)).toBe(code);
  });

  it("handles // and /* */ comments", () => {
    const code = "// one\n/* two\n   lines */\nname = 1";
    expect(kindsOf(code, "comment")).toEqual(["// one", "/* two\n   lines */"]);
  });

  it("an escaped quote does not end the string early", () => {
    const code = 'msg = "say \\"hi\\" now"\nother = 1';
    expect(kindsOf(code, "string")).toEqual(['"say \\"hi\\" now"']);
    expect(kindsOf(code, "number")).toEqual(["1"]);
  });

  it("returns a single plain token for code with nothing to mark", () => {
    expect(tokenizeHcl("  a = b\n")).toEqual([{ text: "  a = b\n", kind: "plain" }]);
  });

  it("survives an unterminated string without losing the text", () => {
    const code = 'name = "unclosed\ncount = 1';
    expect(rejoin(code)).toBe(code);
  });
});
