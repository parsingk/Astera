"use client";

import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { useI18n } from "../../i18n/I18nProvider";
import type { PromptChoice } from "../../../../core/history/promptChoices";
import type { ToolRequestSummary } from "../../../../core/prompts/toolRequest";

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
  /** This is the folder-trust question (core/history/promptLines.ts). It gets its own heading and
   *  drops the hint about typing an answer, because that prompt takes no typing — only one of its
   *  rows. The composer is locked for the same reason; see `isDisabled` in ConversationPane.tsx. */
  trust?: boolean;
  /** What the waiting call is about — the command, the file — from the PreToolUse capture
   *  (core/prompts/toolRequest.ts). Drawn above the quoted screen; null draws nothing extra. */
  about?: ToolRequestSummary | null;
}

/** The banner shown above the composer while the CLI is waiting on a decision it owns. */
export function PendingBanner({
  onGoTerminal,
  lines = [],
  choices = [],
  onChoose,
  answering = false,
  trust = false,
  about = null,
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
          <p className="font-medium">
            {t(trust ? "conversation.pending.trust" : "conversation.pending.title")}
          </p>
          {/* The trust step says what it is in our own words. Quoting the CLI here bought nothing —
              the question is always the same one — and it cost the step its reason to exist on a
              screen that reads back only partly, which is exactly the screen this prompt appears on. */}
          <p>
            {trust
              ? t("conversation.pending.trustBody")
              : t(pickable ? "conversation.pending.pick" : "conversation.pending.body")}
          </p>
        </div>
        <Button
          size="sm"
          variant={pickable ? "outline" : "default"}
          className="shrink-0"
          onClick={onGoTerminal}
        >
          {t(
            pickable || trust ? "conversation.pending.terminal" : "conversation.pending.action"
          )}
        </Button>
      </div>
      {!trust && about !== null && (
        <div
          data-slot="conversation-pending-about"
          className="rounded-md border border-[var(--warn-line)]/60 px-3 py-2 text-xs"
        >
          <p className="font-medium">
            {t("conversation.pending.about")} · {about.tool}
          </p>
          <pre className="mt-1 font-mono whitespace-pre-wrap">{about.lines.join("\n")}</pre>
        </div>
      )}
      {!trust && lines.length > 0 && (
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

/** The messages the CLI is holding until the turn it is on finishes.
 *
 *  Read off its screen, never queued here — the CLI keeps this queue itself and only its copy can be
 *  edited with the up arrow, so a second one would be a second answer to the same question
 *  (core/history/queuedMessages.ts). This only says what is already true over there.
 */
export function QueuedNotice({
  messages,
  onGoTerminal
}: {
  messages: readonly string[];
  onGoTerminal: () => void;
}): ReactNode {
  const { t } = useI18n();
  if (messages.length === 0) return null;

  return (
    <div
      role="status"
      data-slot="conversation-queued"
      className="border-border/60 text-muted-foreground flex items-start justify-between gap-3 rounded-(--composer-radius) border px-4 py-2.5 text-sm"
    >
      <div className="min-w-0">
        <p className="text-foreground font-medium">{t("conversation.queued.title")}</p>
        <ol className="mt-1 flex flex-col gap-0.5">
          {messages.map((text, i) => (
            <li key={`${i}-${text}`} className="truncate">
              {text}
            </li>
          ))}
        </ol>
      </div>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onGoTerminal}>
        {t("conversation.queued.edit")}
      </Button>
    </div>
  );
}

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
