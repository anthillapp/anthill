import { cloneElement, useCallback, useId, useState } from "react";
import type { FocusEvent, KeyboardEvent, MouseEvent, ReactElement } from "react";
import { cx, ensureStyles, ensureTokens } from "../internal/styles.js";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

type TriggerProps = {
  id?: string;
  "aria-describedby"?: string;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
};

export interface TooltipProps {
  /** Text shown in the tooltip bubble. */
  label: string;
  /** Exactly one element. It receives `aria-describedby` and hover/focus handlers. */
  children: ReactElement<TriggerProps>;
  /** Where the bubble sits relative to the trigger. Defaults to `"top"`. */
  placement?: TooltipPlacement;
  /** Extra class on the inline wrapper element. */
  className?: string;
}

const css = `
.anthill-tooltip { position: relative; display: inline-flex; }
.anthill-tooltip__bubble {
  position: absolute;
  z-index: 20;
  max-width: 240px;
  padding: 4px 8px;
  border-radius: 4px;
  background: #18181b;
  color: #fafafa;
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  pointer-events: none;
}
.anthill-tooltip__bubble--top { bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); }
.anthill-tooltip__bubble--bottom { top: calc(100% + 6px); left: 50%; transform: translateX(-50%); }
.anthill-tooltip__bubble--left { right: calc(100% + 6px); top: 50%; transform: translateY(-50%); }
.anthill-tooltip__bubble--right { left: calc(100% + 6px); top: 50%; transform: translateY(-50%); }
`;

/**
 * Wraps a single element and shows a text bubble while that element is hovered
 * or keyboard-focused. The bubble is a `role="tooltip"` node referenced by the
 * trigger's `aria-describedby`, and Escape dismisses it.
 */
export function Tooltip({ label, children, placement = "top", className }: TooltipProps) {
  ensureTokens();
  ensureStyles("tooltip", css);

  const [open, setOpen] = useState(false);
  const tooltipId = `anthill-tooltip-${useId()}`;

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);

  const childProps = children.props;

  const trigger = cloneElement(children, {
    "aria-describedby": open
      ? [childProps["aria-describedby"], tooltipId].filter(Boolean).join(" ")
      : childProps["aria-describedby"],
    onFocus: (event: FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(event);
      show();
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(event);
      hide();
    },
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      childProps.onMouseEnter?.(event);
      show();
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      childProps.onMouseLeave?.(event);
      hide();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      childProps.onKeyDown?.(event);
      if (event.key === "Escape") hide();
    },
  });

  return (
    <span className={cx("anthill-ui", "anthill-tooltip", className)}>
      {trigger}
      {open ? (
        <span
          role="tooltip"
          id={tooltipId}
          className={cx("anthill-tooltip__bubble", `anthill-tooltip__bubble--${placement}`)}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
