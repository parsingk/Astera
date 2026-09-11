"use client";

import { useState, type ReactNode } from "react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { useI18n } from "../../i18n/I18nProvider";

/** One row of the model menu. `key` is whatever the pane needs to act on it — an alias for Claude, a
 *  position in the CLI's own picker for codex — and this component never looks inside it. */
export interface ModelChoice {
  key: string;
  label: string;
}

export interface ModelControlProps {
  /** What to show: the model and effort the CLI last reported, already formatted. Null means the
   *  control is not drawn at all — see ComposerModelSlot in ConversationPane.tsx. */
  line: string | null;
  /** The models this session can be switched to, in the CLI's own order. Empty draws no rows. */
  choices: readonly ModelChoice[];
  onPickModel: (key: string) => void;
  /** Open the CLI's own screen for what cannot be set from here, and go to the terminal. */
  onChangeEffort: () => void;
  /** The label for that row, which differs by CLI: Claude's screen sets effort alone, codex's sets
   *  model and effort together. */
  effortLabel: string;
}

/** The model and effort readout that sits in the composer, right of the attachment button. */
export function ModelControl({
  line,
  choices,
  onPickModel,
  onChangeEffort,
  effortLabel
}: ModelControlProps): ReactNode {
  const { t } = useI18n();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const items: MenuItem[] = [
    ...choices.map((choice): MenuItem => ({ label: choice.label, onSelect: () => onPickModel(choice.key) })),
    ...(choices.length > 0 ? (["separator"] as MenuItem[]) : []),
    { label: effortLabel, onSelect: onChangeEffort }
  ];

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
