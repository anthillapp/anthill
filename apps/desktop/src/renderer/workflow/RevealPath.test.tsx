// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { fileName, homeRelative, RevealPath, revealLabel } from "./RevealPath.js";

describe("the workflow path in the status bar (ANT-206)", () => {
  it("is one button on macOS: folder, path from home, and Reveal in Finder", () => {
    const onReveal = vi.fn();
    render(
      <RevealPath
        path="/Users/me/Library/Application Support/@anthill/desktop/workflows/Ship it.workflow.json"
        platform="darwin"
        home="/Users/me"
        onReveal={onReveal}
      />,
    );
    const control = screen.getByRole("button", { name: "Reveal Ship it.workflow.json in Finder" });
    expect(control.getAttribute("type")).toBe("button");
    expect(control.getAttribute("title")).toBe("Show Ship it.workflow.json in Finder");
    expect(control.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(control.querySelector(".reveal-path-path")?.textContent).toBe(
      "~/Library/Application Support/@anthill/desktop/workflows/Ship it.workflow.json",
    );
    expect(control.querySelector(".reveal-path-action")?.textContent).toBe("· Reveal in Finder");
    fireEvent.click(control);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("says Show in folder on Windows and Linux", () => {
    expect(revealLabel("win32")).toBe("Show in folder");
    expect(revealLabel("linux")).toBe("Show in folder");
    expect(revealLabel(undefined)).toBe("Show in folder");
    render(<RevealPath path="/home/me/w.workflow.json" platform="linux" home="/home/me" onReveal={() => undefined} />);
    expect(screen.getByRole("button", { name: "Show w.workflow.json in its folder" }).textContent).toBe(
      "~/w.workflow.json· Show in folder",
    );
  });

  it("shortens only a path that is inside the home folder", () => {
    expect(homeRelative("/Users/me/a.json", "/Users/me")).toBe("~/a.json");
    expect(homeRelative("/Users/me/a.json", "/Users/me/")).toBe("~/a.json");
    expect(homeRelative("/Users/meg/a.json", "/Users/me")).toBe("/Users/meg/a.json");
    expect(homeRelative("/tmp/a.json", "/Users/me")).toBe("/tmp/a.json");
    expect(homeRelative("/Users/me/a.json", undefined)).toBe("/Users/me/a.json");
    expect(homeRelative("C:\\Users\\me\\a.json", "C:\\Users\\me")).toBe("~\\a.json");
  });

  it("names the file by its last segment on either separator", () => {
    expect(fileName("/a/b/c.workflow.json")).toBe("c.workflow.json");
    expect(fileName("C:\\a\\c.workflow.json")).toBe("c.workflow.json");
  });
});
