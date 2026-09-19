/**
 * The grammar every settings row is written in.
 *
 * One shape, top to bottom: what it is on the left, the control on the right.
 * A row never centres and never fills — a control stretched to the panel's
 * edge stops reading as a control, which is exactly what the app's global
 * `input, select, textarea { width: 100% }` did to a checkbox while the
 * notification setting was being built.
 *
 * The rows come in two kinds and they have to look different, because they ask
 * different things of the reader:
 *
 * - a **setting** carries a control you change, and it applies the moment you
 *   change it. There is no Save, so there is nothing to confirm and no colour
 *   to spend.
 * - a **status** carries a chip you read and, at most, one disclosure. It is a
 *   report about the machine, not an offer, and it is the only kind that uses
 *   colour.
 *
 * Nothing in here brings a heading. The page has one `<h1>` and the groups
 * have small uppercase titles; a row that shouted would put the reader back
 * where the old sheet left them, with a nested card outranking the word
 * Settings.
 */

import type { ReactNode } from "react";

export function SettingGroup({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  /** The group's boundary or caveat, in the app's own voice. */
  footer?: ReactNode;
}) {
  return (
    <>
      <h2 className="set-group-title">{title}</h2>
      <div className="set-group">{children}</div>
      {footer ? <p className="set-group-foot">{footer}</p> : null}
    </>
  );
}

export function SettingRow({
  label,
  note,
  children,
  id,
}: {
  label: string;
  note?: ReactNode;
  /** The control, or the chip. Whatever belongs on the right. */
  children?: ReactNode;
  id?: string;
}) {
  return (
    <div className="set-row">
      <span className="set-row-main">
        <span className="set-label" id={id}>
          {label}
        </span>
        {note ? <span className="set-note">{note}</span> : null}
      </span>
      {children ? <span className="set-row-side">{children}</span> : null}
    </div>
  );
}

export function SettingDivider() {
  return <span className="set-divider" />;
}

/**
 * A switch, and deliberately a `<button>` rather than a checkbox.
 *
 * Two reasons, and the second is the one that matters. It is immune to the
 * global rule that stretches every `input` to the width of its row. And
 * `role="switch"` is what this control actually is: a setting that takes
 * effect on change, with no form around it and nothing to submit — which a
 * checkbox, whose whole grammar is "chosen, pending a Save", is not.
 */
export function SettingSwitch({
  on,
  label,
  onChange,
  disabled = false,
}: {
  on: boolean;
  /** Repeated for a screen reader, because the visible label is a sibling. */
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="set-switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <i aria-hidden="true" />
    </button>
  );
}

/** A state you read. The word carries it; the colour is a second channel. */
export function StateChip({ tone, children }: { tone: "on" | "quiet" | "off"; children: ReactNode }) {
  return (
    <span className={`harness-chip is-${tone}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}
