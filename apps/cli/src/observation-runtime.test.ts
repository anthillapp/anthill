import { describe, expect, it } from "vitest";
import { observationRuntime } from "./observation-runtime.js";

describe("durable observation runtime", () => {
  it("uses the installed app's Node and bundled handler, never the CLI's Node", () => {
    expect(observationRuntime("darwin", "/home/user", (path) => String(path).startsWith("/Applications/Anthill.app/"))).toEqual({
      execPath: "/Applications/Anthill.app/Contents/MacOS/Anthill",
      hookHandlerPath: "/Applications/Anthill.app/Contents/Resources/app.asar/out/main/live-hook-handler.js",
    });
  });
  it("supports a per-user Applications install", () => {
    expect(observationRuntime("darwin", "/home/user", (path) => String(path).startsWith("/home/user/Applications/"))).toMatchObject({
      execPath: "/home/user/Applications/Anthill.app/Contents/MacOS/Anthill",
    });
  });
  it("refuses permanent hooks with an absent or unsupported app runtime", () => {
    expect(observationRuntime("darwin", "/home/user", () => false).installProblem).toContain("installed Anthill");
    expect(observationRuntime("linux", "/home/user", () => true).installProblem).toContain("installed Anthill");
  });
});
