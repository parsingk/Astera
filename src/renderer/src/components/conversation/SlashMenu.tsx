"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { SlashCommand } from "../../../../core/commands/slashCommands";

export interface SlashMenuProps {
  items: readonly SlashCommand[];
  /** Which row Enter would take. Kept by the pane, because the keys that move it are caught on the
   *  composer, not here. */
  active: number;
  onPick: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}

/** The list `/` opens, drawn in the banner slot so it sits directly above the composer with no
 *  positioning of its own. */
export function SlashMenu({ items, active, onPick, onHover }: SlashMenuProps): ReactNode {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Arrowing past the bottom of a long list has to bring the row with it.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      role="listbox"
      data-slot="conversation-slash-menu"
      className="border-border/60 bg-card max-h-64 overflow-y-auto rounded-(--composer-radius) border py-1 text-sm"
    >
      {items.map((item, i) => (
        <button
          key={`${item.source}:${item.name}`}
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
            onPick(item);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="text-foreground shrink-0 font-medium">/{item.name}</span>
          <span className="min-w-0 flex-1 truncate text-xs">{item.description}</span>
          <span className="shrink-0 text-xs opacity-60">{item.source}</span>
        </button>
      ))}
    </div>
  );
}
