/**
 * The launcher, against the real machine where that is safe.
 *
 * The one case worth running for real is the one nobody can fake convincingly:
 * what macOS says when nothing claims a scheme. The message it prints is the
 * whole basis for telling "Anthill is not installed" apart from "the opener
 * fell over", and a test that asserted against a string written here would go
 * on passing after Apple changed it. So the scheme below is one no machine can
 * have a handler for, and opening it opens nothing.
 *
 * Everything else is exercised without spawning anything: the platform refusal
 * takes the platform as an argument, and the disabled launcher runs no process
 * at all.
 */

import { describe, expect, it } from "vitest";

import { disabledLauncher, openUrl } from "./launch.js";

/** A scheme nothing on any machine claims, so opening it opens nothing. */
const UNCLAIMED = "anthill-mcp-test-unclaimed://workflow/w";

const onMac = process.platform === "darwin";

describe("bringing Anthill up", () => {
  it("does not try on a platform Anthill is not packaged for", async () => {
    const report = await openUrl("anthill://workflow/w", "win32");
    expect(report.outcome).toBe("unsupported");
    // The link, because on a platform this cannot open it is the only thing
    // left that works.
    expect(report.message).toContain("anthill://workflow/w");
  });

  it.runIf(onMac)("reports an unregistered scheme as something the user can fix", async () => {
    const report = await openUrl(UNCLAIMED);
    expect(report.outcome).toBe("no_handler");
    // Not "kLSApplicationNotFoundErr": the sentence has to be one the person
    // reading the harness can act on.
    expect(report.message).toContain("Install Anthill");
    expect(report.message).toContain(UNCLAIMED);
    expect(report.message).not.toMatch(/kLSApplicationNotFoundErr|-10814/);
  });

  it("says so when the user turned launching off", async () => {
    const report = await disabledLauncher("anthill://workflow/w");
    expect(report.outcome).toBe("disabled");
    expect(report.message).toContain("--no-launch");
    expect(report.message).toContain("anthill://workflow/w");
  });
});
