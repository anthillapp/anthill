import { forwardRef } from "react";
import type { HTMLAttributes } from "react";
import { cx, ensureStyles, ensureTokens } from "../internal/styles.js";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Arbitrary status text. This component never interprets it. */
  status: string;
  /**
   * Colour treatment. Mapping a domain status ("running", "failed", ...) onto a
   * tone is the caller's job — this kit stays domain-agnostic.
   * Defaults to `"neutral"`.
   */
  tone?: BadgeTone;
}

const css = `
.anthill-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.anthill-badge--neutral { background: #f4f4f5; border-color: #d4d4d8; color: #3f3f46; }
.anthill-badge--info    { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }
.anthill-badge--success { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
.anthill-badge--warning { background: #fffbeb; border-color: #fde68a; color: #b45309; }
.anthill-badge--danger  { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
`;

/**
 * A small coloured pill. The status text itself carries the meaning, so the
 * colour is decoration only and never the sole signal.
 */
export const StatusBadge = forwardRef<HTMLSpanElement, StatusBadgeProps>(function StatusBadge(
  { status, tone = "neutral", className, ...rest },
  ref,
) {
  ensureTokens();
  ensureStyles("badge", css);

  return (
    <span
      {...rest}
      ref={ref}
      className={cx("anthill-ui", "anthill-badge", `anthill-badge--${tone}`, className)}
      data-tone={tone}
    >
      {status}
    </span>
  );
});
