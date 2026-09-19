/**
 * Who handed this workflow over, and what they were asked to do.
 *
 * Read once, to check that the same job was understood — so it hangs off the
 * control that names the source rather than occupying the screen. It used to
 * be a disclosure inside a band of text across the top, which meant the band
 * was always there for something somebody reads once.
 *
 * The task is the user's own words, recorded at the handover and never
 * replaced. It is shown as written, because a paragraph they typed and a
 * single line are both ordinary and neither should be reflowed into the other.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ExchangeSource } from "@anthill/workflow-exchange";

export function ProvenancePopover({
  source,
  onClose,
  anchor,
}: {
  source: ExchangeSource;
  onClose: () => void;
  /**
   * The control this hangs from.
   *
   * Measured rather than offset by a constant, and portalled to the body: the
   * top bar clips its overflow, so a popover positioned inside it is trimmed
   * to the height of the bar.
   */
  anchor?: React.RefObject<HTMLElement | null>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    const box = anchor?.current?.getBoundingClientRect();
    setSpot(box ? { top: box.bottom + 8, right: window.innerWidth - box.right } : { top: 52, right: 16 });
  }, [anchor]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // A frame's delay, so the click that opened this does not close it.
    const timer = window.setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="wf-provenance"
      ref={panel}
      role="dialog"
      aria-label="Original task and source"
      style={spot ? { top: spot.top, right: spot.right } : undefined}
    >
      <p className="task">{source.taskText}</p>
      <p className="meta">
        Source session: <code>{source.sessionId}</code>
      </p>
    </div>,
    document.body,
  );
}
