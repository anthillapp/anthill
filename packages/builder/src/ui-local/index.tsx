/**
 * TEMPORARY LOCAL STAND-INS FOR `@anthill/ui` — replace at integration time.
 *
 * These are intentionally plain and unstyled: just enough structure (panel,
 * button, labelled text input, labelled textarea) for the builder to be usable
 * and testable while the real design-system package is written in parallel.
 * When `@anthill/ui` lands, delete this directory and swap the imports in
 * `NodePalette.tsx`, `NodePropertyPanel.tsx` and `ValidationPanel.tsx`.
 */

import type { ReactNode } from "react";

export type PanelProps = {
  title: string;
  children?: ReactNode;
  /** Rendered next to the title (counts, actions). */
  aside?: ReactNode;
  className?: string;
};

export function Panel({ title, children, aside, className }: PanelProps) {
  return (
    <section className={className} aria-label={title}>
      <header>
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
  className?: string;
};

export function Button({
  children,
  onClick,
  type = "button",
  disabled,
  title,
  className,
}: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={className}
    >
      {children}
    </button>
  );
}

export type TextFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
};

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  id,
}: TextFieldProps) {
  return (
    <label>
      <span>{label}</span>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export type TextAreaFieldProps = TextFieldProps & { rows?: number };

export function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  id,
  rows = 4,
}: TextAreaFieldProps) {
  return (
    <label>
      <span>{label}</span>
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
