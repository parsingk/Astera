"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** One row of the composer's completion list. `key` is what the pane acts on; the rest is what the
 *  reader sees. */
export interface CompletionRow {
  key: string;
  /** The thing itself: `/brainstorming`, or `src/core/conversation.ts`. */
  label: string;
  /** What it is, when there is something worth saying — a command's description, and nothing for a
   *  file, whose path already says it. */
  hint?: string;
  /** A short right-hand tag: where a command came from. */
  right?: string;
}

export interface CompletionMenuProps {
  rows: readonly CompletionRow[];
  /** Which row Enter would take. Kept by the pane, because the keys that move it are caught on the
   *  composer, not here. */
  active: number;
  onPick: (row: CompletionRow) => void;
  onHover: (index: number) => void;
}

/** The list `/` and `@` open, drawn in the banner slot so it sits directly above the composer with no
 *  positioning of its own. */
export function CompletionMenu({ rows, active, onPick, onHover }: CompletionMenuProps): ReactNode {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Arrowing past the bottom of a long list has to bring the row with it.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      role="listbox"
      data-slot="conversation-completion-menu"
      className="border-border/60 bg-card max-h-64 overflow-y-auto rounded-(--composer-radius) border py-1 text-sm"
    >
      {rows.map((row, i) => (
        <button
          key={row.key}
          ref={i === active ? activeRef : undefined}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${
            i === active ? "bg-muted text-foreground" : "text-muted-foreground"
          }`}
          // Chosen on mousedown, not click: a click would first move focus off the composer, and the
          // composer losing focus is what closes this.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(row);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="text-foreground shrink-0 font-medium">{row.label}</span>
          {row.hint !== undefined && (
            <span className="min-w-0 flex-1 truncate text-xs">{row.hint}</span>
          )}
          {row.right !== undefined && (
            <span className="ms-auto shrink-0 text-xs opacity-60">{row.right}</span>
          )}
        </button>
      ))}
    </div>
  );
}
