/**
 * Two things that were wrong at once, and neither showed up where anyone
 * would have looked.
 *
 * Pi had no mark, so every surface that names a CLI beside its logo drew the
 * neutral placeholder for it — a grey disc next to two real marks, which reads
 * as a half-finished app rather than as "Anthill does not have this one"
 * (ANT-128).
 *
 * And the way a mark reaches a `background-image` was a trap that only springs
 * in a packaged build: the bundler inlines a small SVG as a percent-encoded
 * data URI containing single quotes, which are illegal inside an unquoted
 * `url(...)`. In development the same import is a plain file URL, so the two
 * call sites that build one looked fine right up until the build.
 */

import { INTERPRETERS } from "@anthill/workflow";
import { describe, expect, it } from "vitest";

import { INTERPRETER_LOGOS, interpreterLogo, interpreterLogoBackground } from "./interpreter-logos.js";

describe("the marks Anthill shows for a CLI", () => {
  it("has one for every CLI it offers", () => {
    // Not a list written out here: the point is that adding a CLI without
    // finding its mark is caught, and a list copied from the other file would
    // be updated in the same commit that broke this.
    const missing = INTERPRETERS.filter((item) => !INTERPRETER_LOGOS[item.id]).map((item) => item.id);
    expect(missing).toEqual([]);
  });

  it("still answers for a CLI it has no mark for", () => {
    // The placeholder is not dead code — it is what the next CLI gets until
    // somebody finds its mark, and it must stay a usable `src`.
    const mark = interpreterLogo("nothing-anthill-knows" as never);
    expect(mark).toContain("data:image/svg+xml");
  });

  it("quotes a mark that is going into a CSS url()", () => {
    for (const item of INTERPRETERS) {
      const value = interpreterLogoBackground(item.id);
      expect(value.startsWith('url("')).toBe(true);
      expect(value.endsWith('")')).toBe(true);
      // The quotes are the whole point: a bare data URI can carry single
      // quotes, and an unquoted url() containing one is thrown away entirely.
      expect(value.slice(5, -2)).not.toContain('"');
    }
  });
});
