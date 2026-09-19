/**
 * The block library.
 *
 * The list of actions will keep growing, so the category is a select and the
 * list stays short that way — which leaves room for each block's description,
 * the thing that actually tells you which one you want. Search looks across
 * every category, bypassing the select.
 *
 * A category shows everything in it. It used to show only the MVP palette
 * tier, with a button revealing the rest, and the button was the problem: a
 * category already narrows the list to a handful, so a second fold inside it
 * bought nothing and cost a row that had to be understood before the list
 * could be trusted to be the list. `mvpVisibility` still exists on a
 * definition and still means something elsewhere; it no longer decides what
 * this rail shows.
 *
 * Control blocks are a category like any other; giving them their own strip
 * above the list implied they were a different kind of thing. Condition lives
 * here alongside Start, Approval Gate and End: the research's four MVP
 * controls, together. Anthill has no dedicated "condition" node — a branch is
 * an ordinary step with a second output whose condition names the decision it
 * reads (see `OutputInspector`) — so this card seeds a step with two outputs
 * instead of one, ready for that guided editor. It does not add a new way to
 * express a condition or change how one behaves once set.
 */

import { useMemo, useState } from "react";

import { useScrolling } from "./use-scrolling.js";
import {
  ACTION_CATEGORY_LABELS,
  ACTION_CATEGORY_ORDER,
  ACTION_LIBRARY,
  type ActionCategory,
  type ActionDefinition,
} from "@anthill/workflow";
import { CATEGORY_COLORS } from "@anthill/builder";

/** What the library hands to the canvas when a block is dropped. */
export type LibraryBlock = {
  label: string;
  summary: string;
  /** Present for an action; absent for a control block. */
  actionKind?: ActionDefinition["kind"];
  /** Present for a control block. */
  nodeType?: "start" | "approval" | "end";
  color: string;
  /**
   * How many outputs the block starts with. Every block gets one by default so
   * it can be continued immediately; the Condition card starts with two, since
   * a block with only one output has nothing to route.
   */
  seedOutputs?: number;
};

export type CustomBlock = { label: string; summary: string };

type Category = ActionCategory | "control" | "custom";

const CATEGORY_LABELS: Record<Category, string> = {
  control: "Control",
  ...ACTION_CATEGORY_LABELS,
  custom: "Your blocks",
};

const CONTROL_BLOCKS: LibraryBlock[] = [
  {
    label: "Start",
    summary: "Where the workflow begins",
    nodeType: "start",
    color: CATEGORY_COLORS.control,
  },
  {
    label: "Approval Gate",
    summary: "Stop and ask a person before continuing",
    nodeType: "approval",
    color: CATEGORY_COLORS.approval,
  },
  {
    label: "Condition",
    summary: "Adds a Check step with two paths, ready to route on its decision",
    actionKind: "check",
    color: CATEGORY_COLORS.verify,
    seedOutputs: 2,
  },
  {
    label: "End",
    summary: "Where the workflow stops",
    nodeType: "end",
    color: CATEGORY_COLORS.end,
  },
];

/** Every action in a category. All of them: the category is the only filter. */
function actionBlocks(category: ActionCategory): ActionDefinition[] {
  return Object.values(ACTION_LIBRARY).filter(
    (definition) => definition.category === category,
  );
}

function toLibraryBlock(definition: ActionDefinition): LibraryBlock {
  return {
    label: definition.label,
    summary: definition.summary,
    actionKind: definition.kind,
    color: CATEGORY_COLORS[definition.category],
  };
}

function blocksIn(category: Category, custom: CustomBlock[]): LibraryBlock[] {
  if (category === "control") return CONTROL_BLOCKS;
  if (category === "custom") {
    return custom.map((block) => ({
      label: block.label,
      summary: block.summary,
      actionKind: "agent-step" as const,
      color: CATEGORY_COLORS.build,
    }));
  }
  return actionBlocks(category).map(toLibraryBlock);
}

const ALL_CATEGORIES: Category[] = ["control", ...ACTION_CATEGORY_ORDER, "custom"];

/** Total library size, independent of what is currently shown — for the tab count. */
export function totalBlockCount(custom: CustomBlock[]): number {
  return Object.keys(ACTION_LIBRARY).length + CONTROL_BLOCKS.length + custom.length;
}

export type BlockLibraryProps = {
  custom: CustomBlock[];
  onAddCustom: (block: CustomBlock) => void;
  /** Clicking adds the block at a default spot; dragging drops it where you let go. */
  onAdd: (block: LibraryBlock) => void;
};

export function BlockLibrary({ custom, onAddCustom, onAdd }: BlockLibraryProps) {
  const [category, setCategory] = useState<Category>("control");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const list = useScrolling<HTMLDivElement>();
  const [draftLabel, setDraftLabel] = useState("");
  const [draftSummary, setDraftSummary] = useState("");

  // Search always reaches the whole catalog, across categories.
  const everything = useMemo(
    () => ALL_CATEGORIES.flatMap((item) => blocksIn(item, custom)),
    [custom],
  );

  const query = search.trim().toLowerCase();
  const shown = query
    ? everything.filter(
        (block) =>
          block.label.toLowerCase().includes(query) ||
          block.summary.toLowerCase().includes(query),
      )
    : blocksIn(category, custom);

  const submitCustom = () => {
    const label = draftLabel.trim();
    if (!label) return;
    onAddCustom({
      label,
      summary: draftSummary.trim() || "Custom block with no description",
    });
    setDraftLabel("");
    setDraftSummary("");
    setCreating(false);
    setCategory("custom");
  };

  return (
    <div className="library">
      <div className="kicker">
        <span>Block library</span>
        <span>{totalBlockCount(custom)}</span>
      </div>

      <label className="search">
        <span aria-hidden="true">⌕</span>
        {/* No `on-dark` here: the ring goes on the pill this sits inside,
            or it hugs the field and crops the caret against its own edge. */}
        <input
          value={search}
          placeholder="Find a block in any category"
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>

      {!query ? (
        <>
          <div className="kicker">
            <span>Category</span>
            <span>{shown.length}</span>
          </div>
          <select
            className="on-dark"
            value={category}
            onChange={(event) => setCategory(event.target.value as Category)}
          >
            {ALL_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {CATEGORY_LABELS[item]}
              </option>
            ))}
          </select>
        </>
      ) : null}

      {/* The fade says there is more below; the matching padding is what
          keeps the last row fully opaque once you reach the end, so the fade
          never reads as a permanently dimmed list. */}
      <div
        className={`library-list fade-list${list.scrolling ? " is-scrolling" : ""}`}
        ref={list.ref}
      >
        {shown.length === 0 ? (
          <p className="hint">
            {category === "custom" && !query
              ? "No blocks of your own yet. Add one below."
              : "Nothing matches."}
          </p>
        ) : null}

        {shown.map((block) => (
          <button
            key={`${block.label}-${block.actionKind ?? block.nodeType}`}
            className="library-item on-dark"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("application/anthill-block", JSON.stringify(block));
              event.dataTransfer.setData("text/plain", block.label);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => onAdd(block)}
            title={block.summary}
          >
            <span className="swatch" style={{ background: block.color }} />
            <span>
              <strong>{block.label}</strong>
              <small>{block.summary}</small>
            </span>
          </button>
        ))}
      </div>

      {creating ? (
        <>
          <input
            value={draftLabel}
            placeholder="Block name"
            onChange={(event) => setDraftLabel(event.target.value)}
          />
          <input
            value={draftSummary}
            placeholder="What it is for, in one line"
            onChange={(event) => setDraftSummary(event.target.value)}
          />
          <div className="row">
            <button className="primary" onClick={submitCustom}>
              Add
            </button>
            <button onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </>
      ) : category === "custom" ? (
        // Offered only here, because here is where the new block lands. In any
        // other category it implied the block would join the one being looked
        // at, which it never does.
        <button className="add-custom on-dark" onClick={() => setCreating(true)}>
          + Your own block
        </button>
      ) : null}
    </div>
  );
}
