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

  it("keeps the CLI's own locations and drops its checkout path, host and port", () => {
    const frame = (filename: string) => ({ exception: { values: [{ type: "Error", stacktrace: { frames: [{ filename }] } }] } }) as unknown as ErrorEvent;
    const located = (filename: string) => sanitizeErrorEvent(frame(filename)).exception?.values?.[0].stacktrace?.frames?.[0].filename;
    expect(located("/home/someone/src/anthill/apps/cli/out/cli/src/bridge.js")).toBe("app:///cli/cli/src/bridge.js");
    expect(located("http://192.168.1.20:4173/assets/index-Ab12.js")).toBe("app:///cli/renderer/assets/index-Ab12.js");
    expect(located("/home/someone/src/anthill/apps/cli/out/node_modules/x/index.js")).toBe("[external]");
    expect(located("http://127.0.0.1:4173/private/workflow.json")).toBe("[external]");
  });

  it("cuts an oversized report instead of sending it whole", () => {
    const frames = Array.from({ length: 500 }, (_, i) => ({ filename: "out/main/index.js", lineno: i }));
    const values = Array.from({ length: 20 }, () => ({ type: "Error", stacktrace: { frames } }));
    const clean = sanitizeErrorEvent({ exception: { values } } as unknown as ErrorEvent);
    expect(clean.exception?.values).toHaveLength(5);
    expect(clean.exception?.values?.[0].stacktrace?.frames).toHaveLength(100);
    expect(clean.exception?.values?.[0].stacktrace?.frames?.at(-1)?.lineno).toBe(499);
  });
});
