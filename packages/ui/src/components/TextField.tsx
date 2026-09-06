import { forwardRef, useId } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cx, ensureStyles, ensureTokens } from "../internal/styles.js";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Visible label text. Always rendered — pass `hideLabel` to visually hide it. */
  label: ReactNode;
  /** Secondary hint rendered under the input. Suppressed while `error` is set. */
  helperText?: ReactNode;
  /**
   * Error message. When a non-empty string is present the field renders the
   * message and sets `aria-invalid="true"`.
   */
  error?: string;
  /** Keeps the label available to screen readers but hides it visually. */
  hideLabel?: boolean;
}

const css = `
.anthill-field { display: flex; flex-direction: column; gap: 4px; }
.anthill-field__label { font-size: 12px; font-weight: 600; color: var(--anthill-fg-muted); }
.anthill-field__label--hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.anthill-field__input {
  font: inherit;
  font-size: 14px;
  padding: 7px 10px;
  border: 1px solid var(--anthill-border);
  border-radius: var(--anthill-radius);
  background: var(--anthill-bg);
  color: var(--anthill-fg);
  width: 100%;
}
.anthill-field__input:focus-visible { outline: none; border-color: var(--anthill-accent); box-shadow: var(--anthill-focus); }
.anthill-field__input:disabled { opacity: 0.6; cursor: not-allowed; }
.anthill-field__input[aria-invalid="true"] { border-color: var(--anthill-danger); }
.anthill-field__helper { font-size: 12px; color: var(--anthill-fg-muted); }
.anthill-field__error { font-size: 12px; color: var(--anthill-danger); }
`;

/**
 * A labelled single-line text input with optional helper text and error state.
 * Label/input/description ids are wired up automatically.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, helperText, error, hideLabel = false, className, id, type = "text", ...rest },
  ref,
) {
  ensureTokens();
  ensureStyles("field", css);

  const generatedId = useId();
  const inputId = id ?? `anthill-field-${generatedId}`;
  const helperId = `${inputId}-helper`;
  const errorId = `${inputId}-error`;
  const hasError = typeof error === "string" && error.length > 0;
  const showHelper = !hasError && helperText != null && helperText !== "";

  return (
    <div className={cx("anthill-ui", "anthill-field", className)}>
      <label
        className={cx("anthill-field__label", hideLabel && "anthill-field__label--hidden")}
        htmlFor={inputId}
      >
        {label}
      </label>
      <input
        {...rest}
        ref={ref}
        id={inputId}
        type={type}
        className="anthill-field__input"
        aria-invalid={hasError || undefined}
        aria-describedby={hasError ? errorId : showHelper ? helperId : undefined}
      />
      {hasError ? (
        <span className="anthill-field__error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
      {showHelper ? (
        <span className="anthill-field__helper" id={helperId}>
          {helperText}
        </span>
      ) : null}
    </div>
  );
});
