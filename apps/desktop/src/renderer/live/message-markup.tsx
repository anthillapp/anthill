/**
 * Rendering what an agent wrote, safely.
 *
 * Agents write Markdown. Shown as flat text it arrives full of `**`, backticks
 * and `-` bullets, which is a report rendered as its own source code — the one
 * card on the page that is *meant* to be read ends up the hardest to read.
 *
 * The safety here is structural rather than sanitary. This builds React
 * elements directly from the source text and never goes near
 * `dangerouslySetInnerHTML`, so raw HTML in a message cannot become HTML on
 * the page: `<script>` is a string that renders as the characters
 * `<script>`, because that is all React can do with it. There is no sanitiser
 * to get wrong, no allowlist to fall behind a new attack, and nothing to keep
 * up to date — the property comes from the shape of the code.
 *
 * Links are deliberately not clickable. The text is written by an external
 * agent Anthill neither started nor trusts, and turning its words into
 * something that opens the reader's browser hands that agent a capability it
 * has no business having. Both the label and its target are shown, selectable
 * and copyable, and going there stays the reader's own decision — which is
 * also why the target is printed rather than filtered: with nothing to click,
 * a path or a URL is just the detail the reader wanted.
 *
 * The subset is exactly what the excerpt can contain (see
 * `messageExcerpt` — fenced and indented code are removed at ingestion, so
 * they cannot reach here): headings, paragraphs, ordered and unordered lists,
 * bold, italic, inline code and links.
 */

import { Fragment, useEffect, useState, type ReactNode } from "react";

/**
 * Targets not worth printing.
 *
 * Since nothing here is clickable, no scheme can be *executed*, so the only
 * question a target raises is whether showing it helps. A `javascript:` or
 * `data:` target is either an attack that will not fire or a wall of base64;
 * everything else — a URL, an absolute path, a repository-relative one — is
 * exactly the detail a reader came for. An agent writing "the report is at
 * /tmp/x/report.md" should not have the path taken off it.
 */
const POINTLESS_TARGET = /^\s*(javascript|data|vbscript):/i;

/**
 * An absolute local path, as an agent writes one.
 *
 * Deliberately narrow. A relative path is ambiguous — relative to which
 * directory? Anthill did not start the session and does not know its working
 * directory — so only `/…` and `~/…` are recognised, which are the forms that
 * mean the same thing to everyone reading them.
 *
 * The trailing class excludes sentence punctuation, because "the file is at
 * /tmp/report.md." ends in a full stop that is the sentence's, not the path's.
 */
const LOCAL_PATH = /(?:^|(?<=[\s(`'"]))(~?\/[^\s`'"<>|]*[^\s`'"<>|.,;:!?)\]])/g;

/**
 * Whether a path can be revealed, asked of main and cached for the render.
 *
 * The renderer never touches the filesystem. It collects the paths a message
 * mentions, asks main which of them exist, and offers only those — so a path
 * an agent invented, or one that has since been deleted, is text like any
 * other rather than a control that does nothing.
 */
export function useRevealablePaths(text: string): ReadonlySet<string> {
  const [real, setReal] = useState<ReadonlySet<string>>(EMPTY_SET);

  useEffect(() => {
    const found = [...new Set(text.match(LOCAL_PATH) ?? [])];
    if (found.length === 0) {
      setReal(EMPTY_SET);
      return;
    }
    let live = true;
    void window.anthill
      .pathsExist(found)
      .then((answer) => {
        if (!live) return;
        setReal(new Set(Object.entries(answer).flatMap(([path, is]) => (is ? [path] : []))));
      })
      // A path that cannot be checked is shown as text, which is what it was
      // before any of this existed.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [text]);

  return real;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Split a run of text so the revealable paths inside it become their own nodes. */
function withPaths(text: string, revealable: ReadonlySet<string>, keyPrefix: string): ReactNode[] {
  if (revealable.size === 0) return [text];
  const out: ReactNode[] = [];
  let at = 0;
  let n = 0;

  for (const match of text.matchAll(LOCAL_PATH)) {
    const path = match[1];
    if (!revealable.has(path)) continue;
    const start = (match.index ?? 0) + match[0].length - path.length;
    if (start > at) out.push(text.slice(at, start));
    n += 1;
    out.push(<RevealPath key={`${keyPrefix}-p${n}`} path={path} />);
    at = start + path.length;
  }

  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * A path, shown where it lives.
 *
 * A button rather than a link, because it is not one: nothing navigates, and
 * nothing opens. Pressing it selects the item in Finder, which is the thing a
 * reader of "I wrote the report to /tmp/x/report.md" actually wants and the
 * only thing this is allowed to do.
 */
function RevealPath({ path }: { path: string }) {
  return (
    <button
      type="button"
      className="msg-path"
      title={`Show ${path} in Finder. Nothing is opened or run.`}
      onClick={() => void window.anthill.revealPath(path).catch(() => undefined)}
    >
      {path}
    </button>
  );
}

type Block =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

/** Group lines into blocks. Blank lines separate; a run of bullets is a list. */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
      list = undefined;
    }
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      // The card has its own title, so a message's headings sit below it —
      // every level rendered as one of two, rather than competing with the
      // page's own hierarchy.
      blocks.push({
        kind: "heading",
        level: heading[1].length <= 2 ? 2 : 3,
        text: heading[2],
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)?.[1] ?? "");
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/**
 * Inline spans, matched left to right so an earlier marker cannot be swallowed
 * by a later one. Inline code comes first: backticks are literal inside it,
 * and a `**` inside code is two asterisks, not emphasis.
 */
const INLINE = /(`[^`]+`)|(\[[^\]]*\]\([^\s)]+\))|(\*\*[^*]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)/g;

export function renderInline(
  text: string,
  keyPrefix: string,
  /** Paths main confirmed exist. Empty means nothing is offered as clickable. */
  revealable: ReadonlySet<string> = EMPTY_SET,
): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let n = 0;

  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > at) out.push(...withPaths(text.slice(at, start), revealable, `${keyPrefix}-t${n}`));
    const [whole, code, link, strong, emphasis] = match;
    n += 1;
    const key = `${keyPrefix}-${n}`;

    if (code) {
      // A path inside backticks is the commonest way an agent writes one, so
      // the code span keeps its monospace and gains the reveal.
      const inner = code.slice(1, -1);
      out.push(
        <code key={key}>{withPaths(inner, revealable, key)}</code>,
      );
    } else if (link) {
      const split = link.indexOf("](");
      const label = link.slice(1, split);
      const href = link.slice(split + 2, -1);
      // Shown, never followed: the label reads as written, and the URL is
      // beside it so the reader can see where it would have gone.
      out.push(
        <Fragment key={key}>
          {label || (POINTLESS_TARGET.test(href) ? "link" : href)}
          {label && !POINTLESS_TARGET.test(href) && label !== href ? (
            <span className="msg-url"> ({href})</span>
          ) : null}
        </Fragment>,
      );
    } else if (strong) {
      out.push(<strong key={key}>{strong.slice(2, -2)}</strong>);
    } else if (emphasis) {
      out.push(<em key={key}>{emphasis.slice(1, -1)}</em>);
    } else {
      out.push(whole);
    }
    at = start + whole.length;
  }

  if (at < text.length) out.push(...withPaths(text.slice(at), revealable, `${keyPrefix}-tail`));
  return out;
}

/**
 * Cut a message down without cutting through its markup.
 *
 * The collapsed card shows a prefix of the source, and a prefix can end in the
 * middle of `**bold**` or an inline code span — which the parser then renders
 * literally, putting the raw markers back on screen that this whole file
 * exists to take off it. So the cut retreats to the last position where every
 * marker it has opened is also closed.
 */
export function clampMarkup(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);

  // Inline code first: a backtick span makes every other marker inside it
  // literal, so an odd number of backticks means the cut landed inside one.
  const ticks = (cut.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) cut = cut.slice(0, cut.lastIndexOf("`"));

  // Then emphasis, longest marker first so `**` is not read as two `*`.
  for (const marker of ["**", "*", "_"]) {
    const count = cut.split(marker).length - 1;
    if (count % 2 === 1) cut = cut.slice(0, cut.lastIndexOf(marker));
  }

  // And a link whose target the cut never reached.
  const open = cut.lastIndexOf("[");
  if (open > cut.lastIndexOf(")")) cut = cut.slice(0, open);

  return `${cut.trimEnd()}…`;
}

export type MessageMarkupProps = { text: string };

export function MessageMarkup({ text }: MessageMarkupProps) {
  const blocks = parseBlocks(text);
  const revealable = useRevealablePaths(text);
  return (
    <div className="msg-markup">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        if (block.kind === "heading") {
          return block.level === 2 ? (
            <h4 key={key}>{renderInline(block.text, key, revealable)}</h4>
          ) : (
            <h5 key={key}>{renderInline(block.text, key, revealable)}</h5>
          );
        }
        if (block.kind === "list") {
          const items = block.items.map((item, i) => (
            <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`, revealable)}</li>
          ));
          return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
        }
        return <p key={key}>{renderInline(block.text, key, revealable)}</p>;
      })}
    </div>
  );
}
