// src/renderer/src/components/conversation/ChatRequestCard.tsx
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { useI18n } from "../../i18n/I18nProvider";
import { toast } from "../../lib/toast";
import type { MessageKey } from "../../../../core/i18n";
import type { ApprovalDecision, ChatRequest } from "../../../../core/chat/types";
import { allAnswered, emptyAnswers, setOther, togglePick, type Answer } from "../../../../core/prompts/askUserQuestion";
import { forgetOtherAskAnswers, recallAskAnswers, rememberAskAnswers } from "./askDrafts";
import { QuestionCard } from "./QuestionCard";

export interface ChatRequestCardProps {
  sessionId: string;
  request: ChatRequest;
}

/** The order the three decisions are offered in when a request lists them, least to most final —
 *  filtered to whatever `request.decisions` actually carries (a shell command offers all three; a
 *  patch may offer only accept/decline). */
const DECISION_ORDER: ApprovalDecision[] = ["accept", "acceptForSession", "decline"];
const DECISION_LABEL: Record<ApprovalDecision, MessageKey> = {
  accept: "chat.approval.accept",
  acceptForSession: "chat.approval.acceptForSession",
  decline: "chat.approval.decline"
};

const errorMessageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The chat pane's one banner slot while Codex is waiting on an answer only a person can give: an
 * AskUserQuestion form, drawn through the same QuestionCard the terminal sessions use, or a
 * PendingBanner-styled approval for a tool call. Draws only what `request` says right now — the card
 * disappears the moment the pane's own state drops the request (Task 10 unmounts it), so nothing here
 * has to notice that on its own.
 */
export function ChatRequestCard({ sessionId, request }: ChatRequestCardProps): ReactNode {
  if (request.kind === "question") return <QuestionRequestCard sessionId={sessionId} request={request} />;
  return <ApprovalRequestCard sessionId={sessionId} request={request} />;
}

function QuestionRequestCard({
  sessionId,
  request
}: {
  sessionId: string;
  request: Extract<ChatRequest, { kind: "question" }>;
}): ReactNode {
  const { t } = useI18n();
  const key = `${sessionId}|${request.id}`;
  const [draft, setDraft] = useState<{ key: string; answers: Answer[] }>(() => ({
    key,
    answers: recallAskAnswers(key) ?? emptyAnswers(request.form)
  }));
  const [submitting, setSubmitting] = useState(false);

  // A fresh key (a new call) starts from whatever was drafted for it before, or blank; the previous
  // call's draft is no longer wanted — the same rule the terminal side's AskUserQuestion card keeps
  // (ConversationPane.tsx, askDrafts.ts).
  useEffect(() => {
    forgetOtherAskAnswers(key);
    setDraft((prev) => (prev.key === key ? prev : { key, answers: recallAskAnswers(key) ?? emptyAnswers(request.form) }));
    setSubmitting(false);
  }, [key, request.form]);

  useEffect(() => {
    rememberAskAnswers(draft.key, draft.answers);
  }, [draft]);

  // The render right after `key` changes (a new question replacing an answered one) can still see the
  // old draft for one pass, since the effect above runs after render — fall back to blank rather than
  // show the previous question's answers against this one's form.
  const answers = draft.key === key ? draft.answers : emptyAnswers(request.form);
  const update = (next: Answer[]): void => setDraft({ key, answers: next });

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    try {
      await window.api.chat.answer(sessionId, request.id, { kind: "question", answers });
    } catch (err) {
      setSubmitting(false);
      toast.error(t("chat.notice.error", { message: errorMessageOf(err) }));
    }
  };

  return (
    <QuestionCard
      form={request.form}
      answers={answers}
      state={submitting ? "answering" : "ready"}
      notice={null}
      canSubmit={allAnswered(request.form, answers) && !submitting}
      onToggle={(q, option) => update(togglePick(request.form, answers, q, option))}
      onOther={(q, text) => update(setOther(request.form, answers, q, text))}
      onSubmit={() => void submit()}
      onGoTerminal={null}
    />
  );
}

function ApprovalRequestCard({
  sessionId,
  request
}: {
  sessionId: string;
  request: Extract<ChatRequest, { kind: "approval" }>;
}): ReactNode {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const decide = async (decision: ApprovalDecision): Promise<void> => {
    setBusy(true);
    try {
      await window.api.chat.answer(sessionId, request.id, { kind: "approval", decision });
    } catch (err) {
      setBusy(false);
      toast.error(t("chat.notice.error", { message: errorMessageOf(err) }));
    }
  };

  return (
    <div
      role="status"
      data-slot="chat-request-approval"
      className="flex flex-col gap-2 rounded-(--composer-radius) border border-[var(--warn-line)] bg-[var(--warn-bg)] px-4 py-2.5 text-sm text-[var(--warn-ink)]"
    >
      <p className="font-medium">{t("chat.approval.title", { tool: request.about.tool })}</p>
      <pre
        data-slot="chat-request-approval-lines"
        className="max-h-72 overflow-auto rounded-md bg-black/20 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap"
      >
        {request.about.lines.join("\n")}
      </pre>
      <div data-slot="chat-request-approval-choices" className="flex flex-wrap gap-2">
        {DECISION_ORDER.filter((d) => request.decisions.includes(d)).map((decision) => (
          <Button
            key={decision}
            size="sm"
            variant={decision === "accept" ? "default" : "outline"}
            disabled={busy}
            className="max-w-full"
            onClick={() => void decide(decision)}
          >
            {t(DECISION_LABEL[decision])}
          </Button>
        ))}
      </div>
    </div>
  );
}
