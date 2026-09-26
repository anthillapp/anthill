import type { ErrorEvent } from "@sentry/electron/main";
import { describe, expect, it } from "vitest";
import { sanitizeErrorEvent } from "./error-reporting.js";

describe("outbound error reports", () => {
  it("keeps only bundle stack positions and removes private runtime data", () => {
    const event = {
      type: "error",
      message: "secret prompt",
      sdk: { name: "sentry.javascript.electron", version: "7.20.0", settings: { infer_ip: "auto" }, integrations: ["private"] },
      user: { email: "person@example.com" },
      breadcrumbs: [{ message: "private click" }],
      request: { url: "https://example.com/private" },
      contexts: { secret: { value: "private context" } },
      debug_meta: { images: [
        { type: "sourcemap", code_file: "/Users/someone/private/out/renderer/assets/index.js", debug_id: "00000000-0000-0000-0000-000000000001" },
        { type: "macho", code_file: "/Users/someone/private/native", debug_id: "00000000-0000-0000-0000-000000000002", image_addr: "0x123" },
      ] },
      exception: { values: [{
        type: "PrivateError",
        value: "secret file path",
        stacktrace: { frames: [{
          filename: "file:///Applications/Anthill.app/Contents/Resources/app.asar/out/renderer/assets/index.js",
          abs_path: "/Users/someone/private/out/renderer/assets/index.js",
          function: "openWorkflow",
          lineno: 42,
          context_line: "private source text",
          vars: { token: "sensitive" },
        }, { filename: "/Users/someone/private/workflow.json", lineno: 4 }] },
      }] },
    } as unknown as ErrorEvent;
    const clean = sanitizeErrorEvent(event);
    const serialized = JSON.stringify(clean);
    expect(clean.exception?.values?.[0].value).toBe("[redacted]");
    expect(clean.exception?.values?.[0].type).toBe("Error");
    expect(clean.sdk).toEqual({ name: "sentry.javascript.electron", version: "7.20.0", settings: { infer_ip: "never" } });
    expect(clean.exception?.values?.[0].stacktrace?.frames?.[0].filename).toBe("app:///out/renderer/assets/index.js");
    expect(clean.exception?.values?.[0].stacktrace?.frames?.[1].filename).toBe("[external]");
    expect(clean.debug_meta?.images).toEqual([{
      type: "sourcemap",
      code_file: "app:///out/renderer/assets/index.js",
      debug_id: "00000000-0000-0000-0000-000000000001",
    }]);
    for (const privateText of ["secret", "person@", "private", "context_line", "sensitive", "/Users/"]) {
      expect(serialized).not.toContain(privateText);
    }
  });

  it("keeps built-in error class names, which say what failed without saying about what", () => {
    const event = { type: undefined, exception: { values: [{ type: "TypeError", value: "x of /Users/me" }] } } as unknown as ErrorEvent;
    expect(sanitizeErrorEvent(event).exception?.values?.[0]).toEqual({ type: "TypeError", value: "[redacted]" });
  });
});
