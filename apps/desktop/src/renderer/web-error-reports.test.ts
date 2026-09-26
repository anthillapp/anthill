import * as Sentry from "@sentry/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startWebErrorReports } from "./web-error-reports.js";

afterEach(async () => {
  await Sentry.close();
  vi.unstubAllGlobals();
});

describe("the CLI page's error reports", () => {
  it("hand a sanitized event to the CLI and never reach the network themselves", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const reportRendererError = vi.fn(async () => undefined);
    (window as unknown as { anthill: unknown }).anthill = { reportRendererError };

    startWebErrorReports();
    Sentry.captureException(new TypeError("secret prompt from /home/someone"));
    await Sentry.flush(1000);

    expect(reportRendererError).toHaveBeenCalledOnce();
    const sent = JSON.stringify(reportRendererError.mock.calls[0]);
    expect(sent).toContain("TypeError");
    expect(sent).not.toContain("secret");
    expect(sent).not.toContain("/home/someone");
    expect(sent).toContain('"infer_ip":"never"');
    expect(fetch).not.toHaveBeenCalled();
  });
});
