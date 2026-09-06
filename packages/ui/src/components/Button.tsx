import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx, ensureStyles, ensureTokens } from "../internal/styles.js";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual emphasis. Defaults to `"secondary"`. */
  variant?: ButtonVariant;
  /** Control height / padding. Defaults to `"md"`. */
  size?: ButtonSize;
  /**
   * Shows a spinner and blocks interaction. A loading button is rendered as a
   * genuinely `disabled` button, so `onClick` cannot fire while it is set.
   */
  loading?: boolean;
  children?: ReactNode;
}

const css = `
.anthill-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: var(--anthill-radius);
  font: inherit;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
  background: transparent;
  color: var(--anthill-fg);
  transition: background-color 120ms ease, border-color 120ms ease;
}
.anthill-button--md { padding: 8px 14px; font-size: 14px; }
.anthill-button--sm { padding: 4px 10px; font-size: 12px; }
.anthill-button--primary { background: var(--anthill-accent); border-color: var(--anthill-accent); color: #ffffff; }
.anthill-button--primary:hover:not(:disabled) { background: #1d4ed8; }
.anthill-button--secondary { background: var(--anthill-bg); border-color: var(--anthill-border); color: var(--anthill-fg); }
.anthill-button--secondary:hover:not(:disabled) { background: #f4f4f5; }
.anthill-button--danger { background: var(--anthill-danger); border-color: var(--anthill-danger); color: #ffffff; }
.anthill-button--danger:hover:not(:disabled) { background: #b91c1c; }
.anthill-button--ghost { background: transparent; border-color: transparent; color: var(--anthill-fg); }
.anthill-button--ghost:hover:not(:disabled) { background: #f4f4f5; }
.anthill-button:focus-visible { outline: none; box-shadow: var(--anthill-focus); }
.anthill-button:disabled { opacity: 0.55; cursor: not-allowed; }
.anthill-button__spinner {
  width: 1em;
  height: 1em;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: anthill-spin 700ms linear infinite;
  flex: none;
}
@keyframes anthill-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .anthill-button__spinner { animation-duration: 2400ms; }
}
`;

/**
 * A plain, accessible button. All standard button props (including `type`,
 * `onClick`, `aria-*`) are forwarded to the underlying `<button>`.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    disabled = false,
    type = "button",
    className,
    children,
    ...rest
  },
  ref,
) {
  ensureTokens();
  ensureStyles("button", css);

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx(
        "anthill-ui",
        "anthill-button",
        `anthill-button--${variant}`,
        `anthill-button--${size}`,
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
    >
      {loading ? <span className="anthill-button__spinner" data-testid="button-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
});
