import { forwardRef, useId } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { cx, ensureStyles, ensureTokens } from "../internal/styles.js";

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /**
   * Optional header content. When present the panel becomes a labelled region.
   * Note this shadows the DOM `title` attribute, which the panel does not take.
   */
  title?: ReactNode;
  /** Optional controls rendered on the right-hand side of the header. */
  actions?: ReactNode;
  /** Removes the default body padding, for panels holding their own layout. */
  flush?: boolean;
  children?: ReactNode;
}

const css = `
.anthill-panel {
  border: 1px solid var(--anthill-border);
  border-radius: var(--anthill-radius);
  background: var(--anthill-bg);
  overflow: hidden;
}
.anthill-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--anthill-border);
  background: #fafafa;
}
.anthill-panel__title { font-size: 13px; font-weight: 600; margin: 0; }
.anthill-panel__actions { display: flex; align-items: center; gap: 6px; }
.anthill-panel__body { padding: 12px; font-size: 14px; }
.anthill-panel__body--flush { padding: 0; }
`;

/**
 * A bordered container with an optional title header. When `title` is given the
 * panel is exposed as a `region` labelled by that title, so assistive tech can
 * navigate between panels.
 */
export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  { title, actions, flush = false, className, children, ...rest },
  ref,
) {
  ensureTokens();
  ensureStyles("panel", css);

  const generatedId = useId();
  const titleId = `anthill-panel-${generatedId}-title`;
  const hasHeader = title != null || actions != null;

  return (
    <section
      {...rest}
      ref={ref}
      className={cx("anthill-ui", "anthill-panel", className)}
      aria-labelledby={title != null ? titleId : undefined}
    >
      {hasHeader ? (
        <div className="anthill-panel__header">
          {title != null ? (
            <h2 className="anthill-panel__title" id={titleId}>
              {title}
            </h2>
          ) : (
            <span />
          )}
          {actions != null ? <div className="anthill-panel__actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cx("anthill-panel__body", flush && "anthill-panel__body--flush")}>
        {children}
      </div>
    </section>
  );
});
