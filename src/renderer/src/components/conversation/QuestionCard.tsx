// src/renderer/src/components/conversation/QuestionCard.tsx
"use client";

import type { ReactNode } from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../../../core/i18n";
import { isAnswered, type AskForm, type Answer } from "../../../../core/prompts/askUserQuestion";
import type { AskCardState } from "../../../../core/prompts/askScreen";
import type { AskStopReason } from "./askDriver";

export interface QuestionCardProps {
  /** The question as the model wrote it — from the PreToolUse hook, never from the screen. */
  form: AskForm;
  answers: Answer[];
  /** What the card offers right now (core/prompts/askScreen.ts's askCardStateOf). */
  state: AskCardState;
  /** Why the last attempt stopped, if it did. The answers are kept; the terminal button becomes primary. */
  notice: AskStopReason | null;
  canSubmit: boolean;
  onToggle: (question: number, option: number) => void;
  onOther: (question: number, text: string) => void;
  onSubmit: () => void;
  /** null hides the "answer in the terminal" link — a chat session's card has no terminal to fall
   *  back to (ChatRequestCard.tsx). */
  onGoTerminal: (() => void) | null;
}

/**
 * Claude Code's AskUserQuestion as a form: every option a row with its label and description, radios
 * for one choice and checkboxes for several, a free-text row per question because the CLI always offers
 * one, one section per question top to bottom, and a single Submit that is enabled only once every
 * question has an answer. Sits in the banner slot above the composer while the question is waiting.
 *
 * Vertical rather than tabbed on purpose: the complaint this answers was that the content could not be
 * seen, and the CLI's own limits (≤ 4 questions of ≤ 4 options) keep the whole form short. The card
 * scrolls inside itself past half the pane; the composer below never moves.
 */
export function QuestionCard({
  form,
  answers,
  state,
  notice,
  canSubmit,
  onToggle,
  onOther,
  onSubmit,
  onGoTerminal
}: QuestionCardProps): ReactNode {
  const { t } = useI18n();
  const busy = state === "answering";
  const drivable = state === "ready" && notice === null;
  const status: string | null =
    state === "answering"
      ? t("conversation.ask.answering")
      : notice !== null
        ? t(`conversation.ask.stopped.${notice}` as MessageKey)
        : state === "waiting"
          ? t("conversation.ask.waiting")
          : state === "terminal"
            ? t("conversation.ask.terminal")
            : null;

  return (
    <div
      role="form"
      data-slot="conversation-question-card"
      className="border-border/60 bg-background/95 flex flex-col gap-3 rounded-(--composer-radius) border px-4 py-3 text-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">{t("conversation.ask.title")}</p>
        {onGoTerminal !== null && (
          <Button size="sm" variant={drivable ? "outline" : "default"} className="shrink-0" onClick={onGoTerminal}>
            {t("conversation.pending.terminal")}
          </Button>
        )}
      </div>

      <div data-slot="conversation-question-list" className="flex max-h-[50vh] flex-col gap-4 overflow-auto pr-1">
        {form.questions.map((q, qi) => {
          const a = answers[qi] ?? { picks: [], other: "" };
          const answered = isAnswered(form, answers, qi);
          return (
            <section key={`${qi}-${q.question}`} data-slot="conversation-question" className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                {q.header !== "" && (
                  <span className="text-muted-foreground rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                    {q.header}
                  </span>
                )}
                {answered && <CheckIcon className="text-muted-foreground size-3.5" aria-hidden="true" />}
              </div>
              <p className="font-medium">{q.question}</p>
              <div role={q.multiSelect ? "group" : "radiogroup"} className="flex flex-col gap-0.5">
                {q.options.map((opt, oi) => {
                  const on = a.picks.includes(oi);
                  return (
                    <button
                      key={`${oi}-${opt.label}`}
                      type="button"
                      role={q.multiSelect ? "checkbox" : "radio"}
                      aria-checked={on}
                      disabled={busy}
                      onClick={() => onToggle(qi, oi)}
                      className="hover:bg-muted/60 flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-start disabled:opacity-60"
                    >
                      <Indicator kind={q.multiSelect ? "box" : "dot"} on={on} />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{opt.label}</span>
                        {opt.description !== null && (
                          <span className="text-muted-foreground block text-xs leading-snug">{opt.description}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
                <label className="hover:bg-muted/60 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5">
                  <Indicator kind={q.multiSelect ? "box" : "dot"} on={a.other.trim() !== ""} />
                  <span className="text-muted-foreground shrink-0 text-xs">{t("conversation.ask.other")}</span>
                  <input
                    type="text"
                    value={a.other}
                    disabled={busy}
                    placeholder={t("conversation.ask.otherPlaceholder")}
                    onChange={(e) => onOther(qi, e.target.value)}
                    className="border-border/60 placeholder:text-muted-foreground/60 min-w-0 flex-1 border-b bg-transparent px-1 py-0.5 text-sm outline-none focus:border-foreground/60 disabled:opacity-60"
                  />
                </label>
              </div>
            </section>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground min-w-0 text-xs" role="status">
          {busy && <Loader2Icon className="mr-1.5 inline size-3 animate-spin" aria-hidden="true" />}
          {status}
        </p>
        {drivable && (
          <Button size="sm" variant="default" className="shrink-0" disabled={!canSubmit} onClick={onSubmit}>
            {t("conversation.ask.submit")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** A radio dot or a checkbox square, drawn rather than a native input so the whole row is the target. */
function Indicator({ kind, on }: { kind: "dot" | "box"; on: boolean }): ReactNode {
  const shape = kind === "dot" ? "rounded-full" : "rounded-[3px]";
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex size-3.5 shrink-0 items-center justify-center border ${shape} ${on ? "border-foreground bg-foreground" : "border-border"}`}
    >
      {on && (kind === "dot" ? <span className="bg-background size-1.5 rounded-full" /> : <CheckIcon className="text-background size-2.5" />)}
    </span>
  );
}
