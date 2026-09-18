"use client";

import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { useI18n } from "../../i18n/I18nProvider";

/** The mark that says the CLI is doing something.
 *
 *  Drawn at the end of the output, under the last message, rather than above the composer where it
 *  used to be. It goes where the answer itself is about to appear, which is where the person is
 *  already looking, and it leaves the slot above the input for the things that need an answer.
 *
 *  The same pulsing dot a running tool row shows on its right (ToolRow.tsx), on purpose: this view
 *  already says "still going" that way, and one shape for one meaning is worth more here than a
 *  second, wordier one. `working` no longer changes what is drawn — the dot is the same either way —
 *  but it still names the state for anything reading the page out loud: `working` means a tool is
 *  running, which only Claude reports (it has hooks; codex has none), and everything else is the
 *  wait before the first words arrive.
 *
 *  It carries the way to stop, which is the other half of the same report: the composer's own stop
 *  button belongs to assistant-ui's `isRunning`, and that is deliberately narrow — it also decides
 *  whether a message can be typed at all, and both CLIs take one while they work and queue it. So for
 *  most of a turn the button was simply not there, and Escape, which has always worked, is not
 *  something anyone can see. The control sits with the mark instead, up for exactly as long as it is.
 */
export function RunningNotice({
  working,
  onStop
}: {
  working: boolean;
  onStop: () => void;
}): ReactNode {
  const { t } = useI18n();

  return (
    <div
      role="status"
      data-slot="conversation-running"
      aria-label={t(working ? "conversation.running.working" : "conversation.running.thinking")}
      className="text-muted-foreground flex items-center gap-2 py-0.5 text-sm"
    >
      <span aria-hidden className="animate-pulse">
        {"●"}
      </span>
      <button
        type="button"
        onClick={onStop}
        className="hover:text-foreground cursor-pointer text-xs underline-offset-2 hover:underline"
      >
        {t("conversation.running.interrupt")}
      </button>
    </div>
  );
}

/** What the pane says once the session has ended. The composer is shut behind it — the pty is gone and
 *  a word typed here would reach nothing — and the way back is the terminal, which is where a session
 *  is restarted.
 *
 *  `onGoTerminal` null (or absent) hides that way back, for the same reason QuestionCard's own prop
 *  takes null: a chat session has no terminal beside it to go to (ConversationPane.tsx, Task 10). */
export function ExitedNotice({ onGoTerminal }: { onGoTerminal?: (() => void) | null }): ReactNode {
  const { t } = useI18n();

  return (
    <div
      role="status"
      data-slot="conversation-exited"
      className="flex items-center justify-between gap-3 rounded-(--composer-radius) border border-[var(--warn-line)] bg-[var(--warn-bg)] px-4 py-2.5 text-sm text-[var(--warn-ink)]"
    >
      <p className="font-medium">{t("conversation.exited.title")}</p>
      {onGoTerminal !== null && onGoTerminal !== undefined && (
        <Button size="sm" variant="default" className="shrink-0" onClick={onGoTerminal}>
          {t("conversation.pending.terminal")}
        </Button>
      )}
    </div>
  );
}

/** One line a chat session's pane has to say and nobody has to act on: the last turn's error, a replay
 *  whose head was lost, a process that will not outlive the app (paneTransport.ts's ChatBanner). Built
 *  like QueuedNotice and SlashCommandNotice — the same quiet border, the same padding — minus the way
 *  out they offer, because a chat session has no terminal to send anyone to. */
export function ChatNotice({ text }: { text: string }): ReactNode {
  return (
    <div
      role="status"
      data-slot="chat-notice"
      className="border-border/60 text-muted-foreground rounded-(--composer-radius) border px-4 py-2.5 text-sm"
    >
      {text}
    </div>
  );
}
