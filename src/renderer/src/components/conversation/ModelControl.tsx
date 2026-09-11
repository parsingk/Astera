"use client";

import { useState, type ReactNode } from "react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { useI18n } from "../../i18n/I18nProvider";

/** What the menu offers to switch to.
 *
 *  Hand-kept, and it is the one thing here that can go out of date: these are the CLI's own aliases,
 *  which `/model <alias>` takes directly with no screen to drive. A model added upstream is missing
 *  from this list until someone adds it, and one removed upstream answers with the CLI's own error in
 *  the terminal — neither is silent, and the terminal's `/model` still offers whatever is really
 *  there. The labels are the CLI's own names for them, not translated: they are product names.
 *
 *  Effort is deliberately not here. The CLI has no command for it — only the arrows inside `/model`'s
 *  own screen — so this menu opens that screen and takes the person to it rather than driving it
 *  blind and hoping the level list has not moved. */
const MODEL_CHOICES: readonly { alias: string; label: string }[] = [
  { alias: "default", label: "Default" },
  { alias: "opus", label: "Opus" },
  { alias: "opus[1m]", label: "Opus (1M context)" },
  { alias: "sonnet", label: "Sonnet" },
  { alias: "haiku", label: "Haiku" },
  { alias: "fable", label: "Fable" }
];

export interface ModelControlProps {
  /** What to show: the model and effort the CLI last reported, already formatted. Null means the
   *  control is not drawn at all — see ComposerModelSlot in ConversationPane.tsx. */
  line: string | null;
  /** Switch to this alias. The caller writes `/model <alias>` to the pty. */
  onPickModel: (alias: string) => void;
  /** Open the CLI's own model screen and go to the terminal, which is where its effort arrows are. */
  onChangeEffort: () => void;
  /** Whether this CLI can be switched by name. codex cannot: its `/model` only opens a picker, and
   *  an argument is read as a message to answer rather than a command — so for it the menu offers the
   *  screen instead of names it would not understand. */
  canPick: boolean;
}

/** The model and effort readout that sits in the composer, right of the attachment button. */
export function ModelControl({
  line,
  onPickModel,
  onChangeEffort,
  canPick
}: ModelControlProps): ReactNode {
  const { t } = useI18n();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const items: MenuItem[] = canPick
    ? [
        ...MODEL_CHOICES.map(
          (choice): MenuItem => ({ label: choice.label, onSelect: () => onPickModel(choice.alias) })
        ),
        "separator",
        { label: t("conversation.model.effort"), onSelect: onChangeEffort }
      ]
    : [{ label: t("conversation.model.change"), onSelect: onChangeEffort }];

  return (
    <>
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground max-w-56 truncate px-1.5 py-0.5 text-xs"
        aria-label={t("conversation.model.aria")}
        title={t("conversation.model.aria")}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: Math.round(r.left), y: Math.round(r.top) });
        }}
      >
        {line}
      </button>
      {at && <ContextMenu x={at.x} y={at.y} items={items} onClose={() => setAt(null)} />}
    </>
  );
}
