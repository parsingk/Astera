"use client";

import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { useI18n } from "../../i18n/I18nProvider";

export interface PendingBannerProps {
  /** Task 10 wires this to focus the session's terminal. This component only asks for it — it never
   *  draws the CLI's own choices as buttons of its own: the CLI owns that screen, and a second, drawn
   *  copy of it would drift from the real one silently, with a wrong choice there being undoable. */
  onGoTerminal: () => void;
  /** The question, in the CLI's own words, as its terminal is showing it right now
   *  (core/history/promptLines.ts). Quoted rather than rebuilt, for the reason above: a quote cannot
   *  disagree with the screen it came from. Empty draws nothing. */
  lines?: readonly string[];
}

/** The banner shown above the composer while the CLI is waiting on a decision it owns. */
export function PendingBanner({ onGoTerminal, lines = [] }: PendingBannerProps): ReactNode {
  const { t } = useI18n();

  return (
    <div
      role="status"
      data-slot="conversation-pending-banner"
      className="flex flex-col gap-2 rounded-(--composer-radius) border border-[var(--warn-line)] bg-[var(--warn-bg)] px-4 py-2.5 text-sm text-[var(--warn-ink)]"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{t("conversation.pending.title")}</p>
          <p>{t("conversation.pending.body")}</p>
        </div>
        <Button size="sm" className="shrink-0" onClick={onGoTerminal}>
          {t("conversation.pending.action")}
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
    </div>
  );
}

/** The notice shown after a slash command is sent from here.
 *
 *  A slash command's screen is the CLI's own, drawn on the terminal, and none of it reaches the
 *  transcript this pane reads — so `/model` and its kind look, from here, as though nothing happened
 *  at all. Quieter than PendingBanner on purpose: nothing is blocked and nobody has to act, it only
 *  says where the answer went. Same refusal as that banner, for the same reason: it points at the
 *  CLI's screen rather than drawing a second copy of it.
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
