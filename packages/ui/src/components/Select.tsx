import { forwardRef, useId } from "react";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { cx, ensureStyles, ensureTokens } from "../internal/styles.js";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value" | "children" | "size"> {
  /** Visible label text. */
  label: ReactNode;
  options: SelectOption[];
  /** Controlled value. Use `""` together with `placeholder` for "nothing chosen". */
  value: string;
  /** Called with the selected option's `value` (not the raw change event). */
  onChange: (value: string) => void;
  /** Optional non-selectable first entry, rendered with an empty value. */
  placeholder?: string;
  helperText?: ReactNode;
  /** Error message. Renders the message and sets `aria-invalid="true"`. */
  error?: string;
  hideLabel?: boolean;
}

const css = `
.anthill-select { display: flex; flex-direction: column; gap: 4px; }
.anthill-select__label { font-size: 12px; font-weight: 600; color: var(--anthill-fg-muted); }
.anthill-select__label--hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.anthill-select__control {
  font: inherit;
  font-size: 14px;
  padding: 7px 10px;
  border: 1px solid var(--anthill-border);
  border-radius: var(--anthill-radius);
  background: var(--anthill-bg);
  color: var(--anthill-fg);
  width: 100%;
}
.anthill-select__control:focus-visible { outline: none; border-color: var(--anthill-accent); box-shadow: var(--anthill-focus); }
.anthill-select__control:disabled { opacity: 0.6; cursor: not-allowed; }
.anthill-select__control[aria-invalid="true"] { border-color: var(--anthill-danger); }
.anthill-select__helper { font-size: 12px; color: var(--anthill-fg-muted); }
.anthill-select__error { font-size: 12px; color: var(--anthill-danger); }
`;

/** A labelled, controlled native `<select>`. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    options,
    value,
    onChange,
    placeholder,
    helperText,
    error,
    hideLabel = false,
    className,
    id,
    ...rest
  },
  ref,
) {
  ensureTokens();
  ensureStyles("select", css);

  const generatedId = useId();
  const selectId = id ?? `anthill-select-${generatedId}`;
  const helperId = `${selectId}-helper`;
  const errorId = `${selectId}-error`;
  const hasError = typeof error === "string" && error.length > 0;
  const showHelper = !hasError && helperText != null && helperText !== "";

  return (
    <div className={cx("anthill-ui", "anthill-select", className)}>
      <label
        className={cx("anthill-select__label", hideLabel && "anthill-select__label--hidden")}
        htmlFor={selectId}
      >
        {label}
      </label>
      <select
        {...rest}
        ref={ref}
        id={selectId}
        className="anthill-select__control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={hasError || undefined}
        aria-describedby={hasError ? errorId : showHelper ? helperId : undefined}
      >
        {placeholder != null ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {hasError ? (
        <span className="anthill-select__error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
      {showHelper ? (
        <span className="anthill-select__helper" id={helperId}>
          {helperText}
        </span>
      ) : null}
    </div>
  );
});
