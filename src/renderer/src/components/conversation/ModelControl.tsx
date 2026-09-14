"use client";

import { useState, type ReactNode } from "react";
import { Loader2Icon } from "lucide-react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { useI18n } from "../../i18n/I18nProvider";

/** One row of the model menu. `key` is whatever the pane needs to act on it — an alias for Claude, a
 *  position in the CLI's own picker for codex — and this component never looks inside it. */
export interface ModelChoice {
  key: string;
  label: string;
}

export interface ModelControlProps {
  /** What to show: the model and effort the CLI last reported, already formatted. Null when it has
   *  not said yet — codex reports this a turn at a time — and then the button says so rather than
   *  going missing, because the menu under it works either way. */
  line: string | null;
  /** Which CLI this session runs. The caller draws nothing at all when this is null (the account is
   *  gone), because the two CLIs' menus are not interchangeable — see ComposerModelSlot. */
  cli: 'claude' | 'codex' | null;
  /** The models this session can be switched to, in the CLI's own order. Empty draws no rows. */
  choices: readonly ModelChoice[];
  onPickModel: (key: string) => void;
  /** The reasoning levels this session can be set to, in the CLI's own order. Empty draws no rows. */
  effortChoices: readonly ModelChoice[];
  onPickEffort: (key: string) => void;
  /** Open the CLI's own screen for what these rows do not cover — codex keeps Max and Ultra behind a
   *  further screen — and go to the terminal. */
  onChangeEffort: () => void;
  /** The label for that row, which differs by CLI: Claude's screen sets effort alone, codex's sets
   *  model and effort together. */
  effortLabel: string;
  /** A change has been sent and the readout has not caught up. It takes a moment — the CLI has to be
   *  driven and then read back — and without a sign of it the button looks like it ignored the
   *  press. */
  busy?: boolean;
}

/** The model and effort readout that sits in the composer, right of the attachment button. */
export function ModelControl({
  line,
  choices,
  onPickModel,
  effortChoices,
  onPickEffort,
  onChangeEffort,
  effortLabel,
  busy = false
}: ModelControlProps): ReactNode {
  const { t } = useI18n();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  // One flat menu, models first and reasoning levels after a rule. A submenu would read better and
  // ContextMenu has none; a prefix on each level's label says which half of the menu it belongs to
  // without one.
  const items: MenuItem[] = [
    ...choices.map((choice): MenuItem => ({ label: choice.label, onSelect: () => onPickModel(choice.key) })),
    ...(choices.length > 0 && effortChoices.length > 0 ? (["separator"] as MenuItem[]) : []),
    ...effortChoices.map((choice): MenuItem => ({
      label: t("conversation.model.effortRow", { level: choice.label }),
      onSelect: () => onPickEffort(choice.key)
    })),
    ...(effortChoices.length > 0 ? (["separator"] as MenuItem[]) : []),
    { label: effortLabel, onSelect: onChangeEffort }
  ];

  return (
    <>
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground flex max-w-56 items-center gap-1 px-1.5 py-0.5 text-xs"
        aria-label={t("conversation.model.aria")}
        title={t("conversation.model.aria")}
        aria-busy={busy || undefined}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: Math.round(r.left), y: Math.round(r.top) });
        }}
      >
        {busy && <Loader2Icon className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
        <span className="truncate">{line ?? t("conversation.model.unknown")}</span>
      </button>
      {at && <ContextMenu x={at.x} y={at.y} items={items} onClose={() => setAt(null)} />}
    </>
  );
}
