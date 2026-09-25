import { describe, expect, it } from "vitest";

import { hookFingerprint, hookPrompt, isDeclined } from "./hook-prompt.js";

const base = {
  cliAvailable: true,
  entriesPresent: true,
  installed: true,
  usesCurrentRuntime: true,
  codexState: "ready" as const,
  declined: false,
};

describe("what to ask about Anthill's hooks (ANT-138)", () => {
  it("asks nothing when Codex has them installed, enabled and trusted", () => {
    expect(hookPrompt(base)).toBeNull();
  });

  it("asks nothing once a hook has fired in this session, whatever else was read", () => {
    expect(hookPrompt({ ...base, codexState: "unknown", confirmedInSession: true })).toBeNull();
  });

  it("offers to connect hooks that are missing, broken or someone else's runtime", () => {
    expect(hookPrompt({ ...base, entriesPresent: false, installed: false, codexState: undefined })).toBe("connect");
    expect(hookPrompt({ ...base, installed: false })).toBe("connect");
    expect(hookPrompt({ ...base, usesCurrentRuntime: false })).toBe("connect");
  });

  it("asks for trust when Codex holds them untrusted, or switched off", () => {
    expect(hookPrompt({ ...base, codexState: "needs-trust" })).toBe("trust");
    expect(hookPrompt({ ...base, codexState: "disabled" })).toBe("trust");
  });

  it("never calls a check that could not say 'not trusted'", () => {
    expect(hookPrompt({ ...base, codexState: "unknown" })).toBe("hint");
    expect(hookPrompt({ ...base, codexState: "not-loaded" })).toBe("hint");
    expect(hookPrompt({ ...base, codexState: undefined })).toBe("hint");
  });

  it("stays quiet after 'basic progress', and when there is no Codex or no Anthill to install", () => {
    expect(hookPrompt({ ...base, codexState: "needs-trust", declined: true })).toBeNull();
    expect(hookPrompt({ ...base, cliAvailable: false })).toBeNull();
    expect(hookPrompt({ ...base, entriesPresent: false, installProblem: "Install Anthill first." })).toBeNull();
  });
});

describe("a decline is about the commands it was given for", () => {
  const commands = [
    { event: "PreToolUse", command: 'ELECTRON_RUN_AS_NODE=1 "/Applications/Anthill.app/Contents/MacOS/Anthill" h.js anthill-observation-hook codex PreToolUse' },
    { event: "Stop", command: 'ELECTRON_RUN_AS_NODE=1 "/Applications/Anthill.app/Contents/MacOS/Anthill" h.js anthill-observation-hook codex Stop' },
  ];
  const fingerprint = hookFingerprint(commands);

  it("does not depend on the order the commands are listed in", () => {
    expect(hookFingerprint([...commands].reverse())).toBe(fingerprint);
  });

  it("holds for the same commands and lapses when they change", () => {
    expect(isDeclined({ declinedAt: "2026-09-25T00:00:00Z", declinedFor: fingerprint }, fingerprint)).toBe(true);
    const moved = hookFingerprint(commands.map((item) => ({ ...item, command: item.command.replace("/Applications", "/Users/me/Applications") })));
    expect(isDeclined({ declinedAt: "2026-09-25T00:00:00Z", declinedFor: fingerprint }, moved)).toBe(false);
  });

  it("honours a decline written before fingerprints, and ignores a cleared one", () => {
    expect(isDeclined({ declinedAt: "2026-09-24T00:00:00Z" }, fingerprint)).toBe(true);
    expect(isDeclined({ declinedAt: null, declinedFor: null }, fingerprint)).toBe(false);
    expect(isDeclined(undefined, fingerprint)).toBe(false);
  });
});
