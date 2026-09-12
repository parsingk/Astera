"use client";

import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { useI18n } from "../../i18n/I18nProvider";
import type { PromptChoice } from "../../../../core/history/promptChoices";

export interface PendingBannerProps {
  /** Focuses the session's terminal. Still offered with the choices drawn: a prompt this cannot read
   *  — one whose rows do not line up, or that wants free text — leaves nothing to press here. */
  onGoTerminal: () => void;
  /** The question, in the CLI's own words, as its terminal is showing it right now
   *  (core/history/promptLines.ts). Quoted rather than rebuilt: a quote cannot disagree with the
   *  screen it came from. Empty draws nothing. */
  lines?: readonly string[];
  /** The rows of that same quote, as buttons (core/history/promptChoices.ts). Not a second, drawn
   *  copy of the CLI's list — the same text, re-read from the screen on every poll, and the press is
   *  checked against the screen again before anything is confirmed (see `answerChoice` in
   *  ConversationPane.tsx). Empty draws no buttons. */
  choices?: readonly PromptChoice[];
  onChoose?: (choice: PromptChoice) => void;
  /** An answer is on its way to the CLI. The buttons go quiet so a second press cannot race the
   *  first one's walk across the list. */
  answering?: boolean;
}

/** The banner shown above the composer while the CLI is waiting on a decision it owns. */
export function PendingBanner({
  onGoTerminal,
  lines = [],
  choices = [],
  onChoose,
  answering = false,
}: PendingBannerProps): ReactNode {
  const { t } = useI18n();
  const pickable = choices.length > 0 && onChoose !== undefined;

  return (
    <div
      role="status"
      data-slot="conversation-pending-banner"
      className="flex flex-col gap-2 rounded-(--composer-radius) border border-[var(--warn-line)] bg-[var(--warn-bg)] px-4 py-2.5 text-sm text-[var(--warn-ink)]"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{t("conversation.pending.title")}</p>
          <p>{t(pickable ? "conversation.pending.pick" : "conversation.pending.body")}</p>
        </div>
        <Button
          size="sm"
          variant={pickable ? "outline" : "default"}
          className="shrink-0"
          onClick={onGoTerminal}
        >
          {t(pickable ? "conversation.pending.terminal" : "conversation.pending.action")}
        </Button>
      </div>
      {lines.length > 0 && (
        <pre
          data-slot="conversation-pending-screen"
          className="max-h-56 overflow-auto rounded-md bg-black/20 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap"
        >
          {lines.join("\n")}
        </pre>
      )}
      {pickable && (
        <div data-slot="conversation-pending-choices" className="flex flex-wrap gap-2">
          {choices.map((choice) => (
            <Button
              key={choice.label}
              size="sm"
              variant={choice.selected ? "default" : "outline"}
              disabled={answering}
              className="max-w-full"
              onClick={() => onChoose(choice)}
            >
              <span className="truncate">
                {choice.number === null ? choice.label : `${choice.number}. ${choice.label}`}
              </span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The notice shown after a slash command is sent from here.
 *
 *  A slash command's screen is the CLI's own, drawn on the terminal, and none of it reaches the
 *  transcript this pane reads — so `/model` and its kind look, from here, as though nothing happened
 *  at all. Quieter than PendingBanner on purpose: nothing is blocked and nobody has to act, it only
 *  says where the answer went.
 */
export function SlashCommandNotice({ onGoTerminal }: PendingBannerProps): ReactNode {
  const { t } = useI18n();

  return (
    <div
      role="status"
      data-slot="conversation-slash-notice"
      className="border-border/60 text-muted-foreground flex items-center justify-between gap-3 rounded-(--composer-radius) border px-4 py-2.5 text-sm"
    >
      <div className="min-w-0">
        <p className="text-foreground font-medium">{t("conversation.slash.title")}</p>
        <p>{t("conversation.slash.body")}</p>
      </div>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onGoTerminal}>
        {t("conversation.slash.action")}
      </Button>
    </div>
  );
}
