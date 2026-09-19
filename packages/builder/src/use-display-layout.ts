/**
 * One surface's memory of where it drew the blocks a workflow did not place.
 *
 * Kept apart from `withDisplayLayout` because the two have different lifetimes:
 * placing a block is a pure function of the graph, and remembering where it was
 * placed is state that has to outlive the render which decided it. A ref rather
 * than a memo, because a memo is allowed to forget, and a canvas that
 * recomputed its positions on an eviction would rearrange itself for no reason
 * anyone watching could name.
 *
 * Right for a read-only surface as well as an editing one: nothing here needs
 * the workflow to be editable, and a graph handed in again on every poll costs
 * a map lookup per block instead of a fresh layout.
 */

import { useMemo, useRef } from "react";
import type { Workflow } from "@anthill/workflow-schema";

import { withDisplayLayout } from "./display-layout";
import type { Point } from "./geometry";

type Drawn = { id: string; positions: Map<string, Point> };

export function useDisplayLayout(workflow: Workflow): Workflow {
  const drawn = useRef<Drawn | null>(null);

  // A different document, rather than a new version of this one. Its blocks
  // have never been drawn here whatever they are called, and letting one of
  // them keep a place the last document gave that name would put it somewhere
  // nothing in this workflow explains.
  if (!drawn.current || drawn.current.id !== workflow.id) {
    drawn.current = { id: workflow.id, positions: new Map() };
  }

  const { positions } = drawn.current;
  return useMemo(() => withDisplayLayout(workflow, positions), [workflow, positions]);
}
