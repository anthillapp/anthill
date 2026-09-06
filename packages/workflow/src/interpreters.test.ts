import { describe, expect, it } from "vitest";

import { INTERPRETERS, isSignedOutFailure } from "./interpreters.js";

/**
 * Telling "not signed in" apart from every other failure.
 *
 * The recovery differs in kind. "Try again, or reword it" is sound when a model
 * answered badly and useless when a session has expired — rewording a prompt
 * has never signed anyone in, and offering it sends the author round a loop
 * that cannot end. Matched on the CLI's own words because both of these exit 1
 * for everything.
 */
describe("recognising a signed-out CLI", () => {
  it("recognises the message this was found on", () => {
    expect(
      isSignedOutFailure(
        "Claude Code exited with code 1: Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    ).toBe(true);
  });

  it("recognises the other shapes a CLI says it in", () => {
    for (const said of [
      "Error: not logged in",
      "Please run `codex login` to continue",
      "401 Unauthorized",
      "Your login has expired",
    ]) {
      expect(isSignedOutFailure(said)).toBe(true);
    }
  });

  it("does not read an ordinary failure as a sign-in problem", () => {
    // Sending someone to sign in when they are already signed in is the same
    // mistake in the other direction.
    for (const said of [
      "No JSON object was found in the reply.",
      "Claude Code exited with code 1: model overloaded, try again",
      "The proposal names a block that does not exist.",
      "spawn claude ENOENT",
    ]) {
      expect(isSignedOutFailure(said)).toBe(false);
    }
  });

  it("gives every interpreter a sign-in command to hand over", () => {
    for (const item of INTERPRETERS) {
      expect(item.signIn.length).toBeGreaterThan(0);
      // It has to be that CLI's own command, or the advice is wrong again.
      expect(item.signIn.startsWith(item.command)).toBe(true);
    }
  });
});
