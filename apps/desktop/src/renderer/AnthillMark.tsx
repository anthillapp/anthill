/**
 * The Anthill mark: a chevron A whose counter holds a mound.
 *
 * The letter and the anthill in one figure, replacing the accent square that
 * stood in for it. One drawing serves every placement because the two colours
 * are not written into it: the ink is `currentColor`, so it takes the colour of
 * wherever it sits, and the hill is the accent token. A single-colour cut — for
 * a dock icon or a favicon — is the same drawing with `--accent` set to
 * `currentColor` locally.
 *
 * The ink occupies 44×40 of the 48×48 grid, so a 104px mark measures 95×87.
 * That is correct rather than clipping: the square viewBox is what makes every
 * placement share one optical size.
 */

export type AnthillMarkProps = {
  /** Rendered box, in px. The ink sits inside it with its own optical margin. */
  size?: number;
  className?: string;
  /** Set when the mark is the only thing naming the app on that screen. */
  title?: string;
};

export function AnthillMark({ size = 24, className, title }: AnthillMarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role={title ? "img" : "presentation"}
      {...(title ? { "aria-label": title } : { "aria-hidden": true })}
    >
      <path d="M24 4 L46 44 H35.5 L24 22 L12.5 44 H2 Z" fill="currentColor" />
      <path d="M24 27 L33 44 H15 Z" fill="var(--accent)" />
    </svg>
  );
}
