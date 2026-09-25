/**
 * The launcher, against the real machine where that is safe.
 *
 * The one case worth running for real is the one nobody can fake convincingly:
 * what macOS says when there is no such app. The message it prints is the
 * whole basis for telling "Anthill is not installed" apart from "the opener
 * fell over", and a test that asserted against a string written here would go
 * on passing after Apple changed it. So the bundle id below is one no machine
 * can have, and opening with it opens nothing — never the Anthill that may be
 * installed on the machine running the suite.
 *
 * Everything else is exercised without spawning anything: the platform refusal
 * takes the platform as an argument, and the disabled launcher runs no process
 * at all.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ANTHILL_BUNDLE_ID, disabledLauncher, openUrl } from "./launch.js";

/** A bundle id no machine has, so opening with it opens nothing. */
const NO_SUCH_APP = "com.anthill.test.no-such-app";
const URL = "anthill://workflow/w";

const onMac = process.platform === "darwin";

describe("bringing Anthill up", () => {
  it("does not try on a platform Anthill is not packaged for", async () => {
    const report = await openUrl("anthill://workflow/w", "win32");
    expect(report.outcome).toBe("unsupported");
    // The link, because on a platform this cannot open it is the only thing
    // left that works.
    expect(report.message).toContain("anthill://workflow/w");
  });

  it.runIf(onMac)("reports a missing Anthill as something the user can fix", async () => {
    const report = await openUrl(URL, "darwin", NO_SUCH_APP);
    expect(report.outcome).toBe("no_handler");
    // Not "LSCopyApplicationURLsForBundleIdentifier() failed": the sentence has
    // to be one the person reading the harness can act on.
    expect(report.message).toContain("Install Anthill");
    expect(report.message).toContain(URL);
    expect(report.message).not.toMatch(/LSCopyApplicationURLsForBundleIdentifier|kLSApplicationNotFoundErr|-10814/);
  });

  /**
   * ANT-137. The link goes to Anthill by bundle id, so a scheme registration
   * some other Electron has taken over cannot send a handover astray — and the
   * id it goes to has to be the one the app is actually built with.
   */
  it("addresses the app the desktop build produces", () => {
    const desktop = JSON.parse(
      readFileSync(new globalThis.URL("../../desktop/package.json", import.meta.url), "utf8"),
    ) as { build?: { appId?: string } };
    expect(ANTHILL_BUNDLE_ID).toBe(desktop.build?.appId);
  });

  it("says so when the user turned launching off", async () => {
    const report = await disabledLauncher("anthill://workflow/w");
    expect(report.outcome).toBe("disabled");
    expect(report.message).toContain("--no-launch");
    expect(report.message).toContain("anthill://workflow/w");
  });
});
