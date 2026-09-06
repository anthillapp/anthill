/**
 * The escaping, because a file Codex cannot parse is worse than no file: the
 * agent silently does not exist and the session runs without it.
 */

import { describe, expect, it } from "vitest";

import { tomlMultiline, tomlString, tomlTable } from "./toml.js";

describe("a basic string", () => {
  it("escapes what the spec requires", () => {
    expect(tomlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(tomlString("a\\b")).toBe('"a\\\\b"');
    expect(tomlString("one\ntwo")).toBe('"one\\ntwo"');
    expect(tomlString("a\tb")).toBe('"a\\tb"');
  });

  it("escapes control characters, which have no literal form", () => {
    expect(tomlString("a\u0007b")).toBe('"a\\u0007b"');
  });
});

describe("a multi-line string", () => {
  it("starts the text at the margin rather than beside the delimiter", () => {
    expect(tomlMultiline("First line.\nSecond line.")).toBe(
      '"""\nFirst line.\nSecond line."""',
    );
  });

  /* The only thing that can close the string early. */
  it("breaks up a run of quotes that would close it", () => {
    const written = tomlMultiline('he said """ loudly');
    expect(written).not.toMatch(/[^\\]"""\s/);
    expect(written.startsWith('"""\n')).toBe(true);
  });

  /* Inside a multi-line *basic* string a backslash still starts an escape, so
     an instruction mentioning a Windows path would change meaning. */
  it("escapes backslashes, which still escape here", () => {
    expect(tomlMultiline("C:\\Users\\nick")).toBe('"""\nC:\\\\Users\\\\nick"""');
  });
});

describe("a table", () => {
  it("leaves an absent value out rather than writing it empty", () => {
    // Omission is an instruction to Codex — inherit the session's model. An
    // empty value is a mistake it has to make sense of.
    expect(
      tomlTable([
        { key: "name", value: "reviewer" },
        undefined,
        { key: "description", value: "Reads the diff" },
      ]),
    ).toBe('name = "reviewer"\ndescription = "Reads the diff"');
  });
});
