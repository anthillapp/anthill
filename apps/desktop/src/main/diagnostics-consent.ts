/**
 * How a change on the Privacy page takes effect, shared by the desktop and the
 * CLI so the two shells cannot disagree about what consent means.
 *
 * Revoking is immediate: the gate closes before the reply, and analytics drops
 * its client and identifier before the settings are even written. Granting
 * error reports waits for the next launch, because Sentry starts at launch.
 */
import type { DesktopAnalytics } from "./analytics.js";
import type { Settings, SettingsStore } from "./settings.js";

/** What the running process may still send. Read by `beforeSend` on every event. */
export type ReportingGate = {
  errors: boolean;
  nativeCrashes: boolean;
};

export async function writeSettingsWithConsent(
  store: Pick<SettingsStore, "read" | "write">,
  analytics: Pick<DesktopAnalytics, "enable" | "disable" | "capture">,
  gate: ReportingGate,
  patch: Partial<Settings>,
  options: { nativeCrashes: boolean },
): Promise<Settings> {
  const previous = await store.read();
  const requested = { ...patch };
  if (requested.errorReportingEnabled === false) requested.nativeCrashReportingEnabled = false;
  if (
    requested.nativeCrashReportingEnabled === true &&
    (!options.nativeCrashes || !(requested.errorReportingEnabled ?? previous.errorReportingEnabled))
  ) {
    requested.nativeCrashReportingEnabled = false;
  }
  if (requested.analyticsEnabled === false && previous.analyticsEnabled) await analytics.disable();
  let next: Settings;
  try {
    next = await store.write(requested);
  } catch (error) {
    if (previous.analyticsEnabled) await analytics.enable().catch(() => undefined);
    throw error;
  }
  if (next.analyticsEnabled && !previous.analyticsEnabled) {
    try {
      await analytics.enable();
      analytics.capture("analytics_enabled");
    } catch (error) {
      await store.write({ analyticsEnabled: false });
      throw error;
    }
  }
  if (!next.nativeCrashReportingEnabled) gate.nativeCrashes = false;
  if (!next.errorReportingEnabled) {
    gate.errors = false;
    gate.nativeCrashes = false;
  }
  return next;
}
