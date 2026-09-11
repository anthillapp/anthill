/**
 * The CLI's answer to the desktop's file dialog.
 *
 * On the desktop, "Open" shows a native file dialog. The CLI has no dialog to
 * show, so it hands the renderer the workflow files it knows about (the
 * recents and the files in the configured workspace) and this screen lets the
 * author pick one. A pick is a second `openWorkflow` call, with the chosen
 * path — the same path the desktop's dialog would have produced.
 */

import { useEffect, useMemo, useState } from "react";

export type WorkflowPickerProps = {
  candidates: string[];
  onPick: (path: string) => void;
  onClose: () => void;
};

export function WorkflowPicker({ candidates, onPick, onClose }: WorkflowPickerProps) {
  const [filter, setFilter] = useState("");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter((path) => path.toLowerCase().includes(needle));
  }, [candidates, filter]);

  return (
    <div
      className="modal-scrim"
      role="presentation"
      // Only the backdrop dismisses. A click inside the panel must not bubble
      // out and close the picker.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="picker"
        role="dialog"
        aria-modal="true"
        aria-label="Choose a workflow to open"
      >
        <header className="picker-top">
          <div className="picker-titles">
            <h1>Open a workflow</h1>
            <p>Choose one of the workflows Anthill knows about.</p>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <input
          className="picker-filter"
          type="search"
          placeholder="Filter…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <ul className="picker-list">
          {visible.map((path) => (
            <li key={path}>
              <button type="button" onClick={() => onPick(path)}>
                <code>{path}</code>
              </button>
            </li>
          ))}
          {visible.length === 0 ? (
            <li className="picker-empty">No matching workflows.</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
