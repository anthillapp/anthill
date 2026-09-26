import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

import { Root } from "./Root.js";

/**
 * Under the desktop, the preload has already injected `window.anthill` before
 * this runs, so the bridge is a no-op. Under the CLI there is no preload, so
 * the web bridge (a separate bundle, `apps/cli/src/web-bridge.ts`) provides it
 * from the WebSocket at `/api`. The render waits for it, so `Root` never sees
 * a missing bridge.
 */
/**
 * Catch this page's errors, when the shell started with error reports on.
 *
 * Under the desktop they go through Sentry's Electron IPC to main; under the
 * CLI they go over the bridge to the CLI process. Either way the shell's own
 * consent gate decides, and never a request from this page to the network.
 * Loaded on demand, so a shell with reports off never loads an SDK.
 */
async function startErrorReports(desktop: boolean): Promise<void> {
  if (!import.meta.env.PROD) return;
  try {
    if (desktop) {
      if (!window.anthill.errorReportingAtLaunch) return;
      const Sentry = await import("@sentry/electron/renderer");
      const { sanitizeErrorEvent } = await import("../shared/error-reporting.js");
      Sentry.init({
        defaultIntegrations: [Sentry.globalHandlersIntegration()],
        sendDefaultPii: false,
        sendClientReports: false,
        tracesSampleRate: 0,
        beforeSend: sanitizeErrorEvent,
      });
    } else if ((await window.anthill.capabilities()).errorReports) {
      (await import("./web-error-reports.js")).startWebErrorReports();
    }
  } catch {
    // Diagnostics never stand between the author and the app.
  }
}

async function bootstrap(): Promise<void> {
  const existing = (window as unknown as { anthill?: unknown }).anthill;
  if (!existing) {
    const { installWebBridge } = await import(
      "../../../cli/src/web-bridge"
    );
    await installWebBridge();
  }
  await startErrorReports(Boolean(existing));
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

void bootstrap();
