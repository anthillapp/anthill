/**
 * Error reports for the page the CLI serves to a browser.
 *
 * The page sends nothing to Sentry itself: its CSP allows only its own origin,
 * and the CLI's consent gate is the one that has to decide. Sentry's browser
 * SDK is used only to turn an uncaught error into an event; `beforeSend`
 * sanitizes it, hands it to the CLI over the bridge, and drops the original.
 */
import * as Sentry from "@sentry/browser";

import { SENTRY_DSN, sanitizeErrorEvent } from "../shared/error-reporting.js";

export function startWebErrorReports(): void {
  Sentry.init({
    // Needed for the SDK to process events at all; the transport below means
    // nothing is ever sent to it from here.
    dsn: SENTRY_DSN,
    transport: () => ({ send: async () => ({}), flush: async () => true }),
    defaultIntegrations: false,
    integrations: [Sentry.globalHandlersIntegration()],
    sendDefaultPii: false,
    sendClientReports: false,
    tracesSampleRate: 0,
    beforeSend: (event) => {
      void window.anthill.reportRendererError?.(sanitizeErrorEvent(event)).catch(() => undefined);
      return null;
    },
  });
}
