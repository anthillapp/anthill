/**
 * The workflow's JSON, named in the status bar, and the way to it (ANT-206).
 *
 * The path is the control. A separate Reveal button beside a path that cannot
 * be clicked says the same thing twice, and of the two only the path tells
 * which file Finder is about to show. So the folder icon, the path and the
 * action are one button with no button chrome: hovering lights them up
 * together, and the action is never what gets cut when the bar runs short —
 * the path is.
 */

/** Where the file manager is named for what it is (Finder), and elsewhere for what it does. */
export function revealLabel(platform: string | undefined): string {
  return platform === "darwin" ? "Reveal in Finder" : "Show in folder";
}

/** `~/workflows/x.workflow.json` is readable; the full path to it is not. */
export function homeRelative(path: string, home: string | undefined): string {
  if (!home) return path;
  const trimmed = home.replace(/[\\/]+$/, "");
  if (!trimmed || !path.startsWith(trimmed)) return path;
  const rest = path.slice(trimmed.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("\\") ? `~${rest}` : path;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

type RevealPathProps = {
  path: string;
  /** As the shell names it (`darwin`, `linux`, `win32`); unknown reads as not macOS. */
  platform: string | undefined;
  home: string | undefined;
  onReveal: () => void;
};

export function RevealPath({ path, platform, home, onReveal }: RevealPathProps) {
  const name = fileName(path);
  const inFinder = platform === "darwin";
  return (
    <button
      type="button"
      className="reveal-path on-dark"
      onClick={onReveal}
      title={inFinder ? `Show ${name} in Finder` : `Show ${name} in its folder`}
      aria-label={inFinder ? `Reveal ${name} in Finder` : `Show ${name} in its folder`}
    >
      {/* Lucide `folder`. currentColor, so it lights up with the text. */}
      <svg
        className="reveal-path-icon"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </svg>
      <span className="reveal-path-path">{homeRelative(path, home)}</span>
      <span className="reveal-path-action">· {revealLabel(platform)}</span>
    </button>
  );
}
