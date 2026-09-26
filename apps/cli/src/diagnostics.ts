/**
 * Optional diagnostics for the CLI shell, on the same terms as the desktop:
 * off until the author turns them on in Settings → Privacy, error reports from
 * the next start, and revoking either stops it at once.
 *
 * The browser page never talks to PostHog or Sentry itself. Its errors come
 * over the bridge, sanitized there and again here, and leave from this process
 * through the one consent gate, so the page's CSP stays `default-src 'self'`.
 * There are no native crash reports: there is no Electron here to dump.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";

import { DesktopAnalytics } from "../../desktop/src/main/analytics.js";
import type { ReportingGate } from "../../desktop/src/main/diagnostics-consent.js";
import { reportingConsentOnDisk } from "../../desktop/src/main/settings.js";
import { SENTRY_DSN, sanitizeErrorEvent } from "../../desktop/src/shared/error-reporting.js";

export type CliDiagnostics = {
  analytics: DesktopAnalytics;
  gate: ReportingGate;
  /** Whether Sentry started, which is what the page is told. */
  errorReportsAtLaunch: boolean;
  /** Report an error the browser page caught, if reports are still allowed. */
  reportRendererError(event: unknown): void;
};

/** The CLI's version, from its own package.json, found upward from this file. */
function cliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (manifest.name === "@anthill/cli" && manifest.version) return manifest.version;
    }
    dir = dirname(dir);
  }
  return "unknown";
}

let active: CliDiagnostics | undefined;

export function startCliDiagnostics(userData: string): CliDiagnostics {
  const gate: ReportingGate = { errors: false, nativeCrashes: false };
  const consent = reportingConsentOnDisk(join(userData, "settings.json"));
  let errorReportsAtLaunch = false;
  if (consent.errorReportingEnabled) {
    try {
      Sentry.init({
        dsn: SENTRY_DSN,
        release: `anthill-cli@${cliVersion()}`,
        environment: "production",
        // No automatic context, breadcrumbs, HTTP or module lists: only the
        // two handlers that turn a crash into a report. Rejections still end
        // the process, as they do in Node without Sentry.
        defaultIntegrations: false,
        integrations: [
          Sentry.onUncaughtExceptionIntegration(),
          Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
        ],
        skipOpenTelemetrySetup: true,
        sendDefaultPii: false,
        sendClientReports: false,
        tracesSampleRate: 0,
        includeLocalVariables: false,
        beforeSend: (event) => (gate.errors ? sanitizeErrorEvent(event) : null),
      });
      gate.errors = true;
      errorReportsAtLaunch = true;
    } catch (error) {
      console.error("Anthill: error reporting could not start:", error);
    }
  }
  active = {
    analytics: new DesktopAnalytics(userData, true),
    gate,
    errorReportsAtLaunch,
    reportRendererError(event) {
      if (!gate.errors || typeof event !== "object" || event === null) return;
      Sentry.captureEvent(sanitizeErrorEvent(event as ErrorEvent));
    },
  };
  return active;
}

/** The last word on a failure that ends `main`, sent before the process exits. */
export async function reportFatal(error: unknown): Promise<void> {
  if (!active?.gate.errors) return;
  Sentry.captureException(error instanceof Error ? error : new Error("CLI failed"));
  await Sentry.flush(2000).catch(() => false);
}
