/**
 * Minimal style plumbing for the component kit.
 *
 * The package is built with plain `tsc` (no bundler), so importing `.css` files
 * from `.tsx` sources is not an option: it would neither typecheck nor resolve
 * at runtime. Instead each component co-locates its CSS as a string and calls
 * `ensureStyles(id, css)` during render. The stylesheet is appended to
 * `document.head` at most once per id, is inert during SSR, and consumers need
 * no build tooling at all.
 */

const injected = new Set<string>();

export function ensureStyles(id: string, css: string): void {
  if (typeof document === "undefined") return;
  if (injected.has(id)) return;
  injected.add(id);

  const existing = document.querySelector(`style[data-anthill-ui="${id}"]`);
  if (existing) return;

  const style = document.createElement("style");
  style.setAttribute("data-anthill-ui", id);
  style.textContent = css;
  document.head.appendChild(style);
}

/** Joins truthy class names. */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/** Design tokens shared by every component, injected once. */
export const tokensCss = `
.anthill-ui {
  --anthill-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --anthill-radius: 6px;
  --anthill-border: #d4d4d8;
  --anthill-fg: #18181b;
  --anthill-fg-muted: #52525b;
  --anthill-bg: #ffffff;
  --anthill-accent: #2563eb;
  --anthill-danger: #dc2626;
  --anthill-focus: 0 0 0 2px #ffffff, 0 0 0 4px #2563eb;
  font-family: var(--anthill-font);
  color: var(--anthill-fg);
  box-sizing: border-box;
}
.anthill-ui *,
.anthill-ui *::before,
.anthill-ui *::after {
  box-sizing: inherit;
}
`;

export function ensureTokens(): void {
  ensureStyles("tokens", tokensCss);
}
