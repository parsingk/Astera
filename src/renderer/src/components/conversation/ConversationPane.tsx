"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { ChevronUpIcon } from "lucide-react";
import { Thread, type ThreadComponents } from "../assistant-ui/elements/thread.aui";
import { TooltipIconButton } from "../assistant-ui/elements/tooltip-icon-button";
import { ToolRow, ToolRowGroup } from "./ToolRow";
import { PendingBanner } from "./PendingBanner";
import { useI18n } from "../../i18n/I18nProvider";
import type { ConvPart, ConvTurn } from "../../../../core/history/convTypes";
import type { Attention } from "../../../../core/types";

export interface ConversationPaneProps {
  sessionId: string;
  /** Task 10 wires this to focus the session's terminal — the same contract as PendingBanner.tsx's own
   *  prop of this name. This pane only threads it through to the banner. */
  onGoTerminal: () => void;
}

// ---- pure functions ------------------------------------------------------------------------
// toThreadMessages, mergeTurns and composerTextOf are exported and tested on their own
// (conversationPane.test.ts) — the mapping and the merge are where a wrong answer is silent, so
// they are not left to the hand-checked cover the rest of this file gets.

function toThreadPart(part: ConvPart) {
  if (part.kind === "text") return { type: "text" as const, text: part.text };
  // ToolRow (./ToolRow.tsx) reads `result === undefined` as "still running". ConvPart's own
  // "no result yet" is `null`, so the nullish-coalescing here is what turns that corner —
  // passing `null` straight through would read as a finished, empty-result call instead.
  return {
    type: "tool-call" as const,
    toolCallId: part.id,
    toolName: part.name,
    args: { target: part.target },
    result: part.outcome ?? undefined,
  };
}

/** ConvTurn (core/history/convTypes.ts) — main's transcript reduction — into ThreadMessageLike, what
 *  the external-store runtime below reads. */
export function toThreadMessages(turns: readonly ConvTurn[]): ThreadMessageLike[] {
  return turns.map((turn) => ({
    id: turn.id,
    role: turn.role,
    content: turn.parts.map(toThreadPart),
  }));
}

/**
 * `conversation:append` carries new **or updated** turns (see the event's own doc comment on
 * CoreEvents in core/types.ts): a tool call's result routinely lands in a later read than its call
 * did, and main resends that turn whole, with the same id, once it does. Replacing by id in place —
 * never appending a turn whose id is already held — is what keeps a resolved turn from sinking below
 * turns main sent later in the same tick.
 *
 * `restarted` discards everything already held: the transcript file was recreated (e.g. a resumed
 * session reusing the path), so `incoming` is the whole conversation from here, not an addition to
 * what was drawn before.
 */
export function mergeTurns(
  existing: readonly ConvTurn[],
  incoming: readonly ConvTurn[],
  restarted: boolean
): ConvTurn[] {
  if (restarted) return [...incoming];
  const merged = [...existing];
  for (const turn of incoming) {
    const i = merged.findIndex((t) => t.id === turn.id);
    if (i === -1) merged.push(turn);
    else merged[i] = turn;
  }
  return merged;
}

function isTextPart(part: { type: string; text?: string }): part is { type: "text"; text: string } {
  return part.type === "text";
}

/** What the composer's `onNew` writes to the pty: the typed text, and nothing else. An attachment or
 *  any other part kind that might ride along in `AppendMessage.content` is silently dropped — there
 *  is no pty-shaped thing to send for it. */
export function composerTextOf(parts: AppendMessage["content"]): string {
  return parts.filter(isTextPart).map((part) => part.text).join("");
}

// ---- component ------------------------------------------------------------------------------

type Status = "loading" | "unavailable" | "ready";

/**
 * Reads one session's conversation, follows it live, and lets a person type into the same pty the
 * terminal writes to. Not mounted anywhere yet — Task 10 places it in the session tab.
 *
 * Kept thin on purpose: every hook below either owns a small, obvious piece of wiring (the open/close
 * lifecycle, the two event subscriptions, load-more's paging) or reads one of the pure functions
 * above. Nothing here decides what a tool row or the pending banner look like — those are Task 8's.
 */
export function ConversationPane({ sessionId, onGoTerminal }: ConversationPaneProps): ReactNode {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>("loading");
  const [turns, setTurns] = useState<ConvTurn[]>([]);
  const [from, setFrom] = useState(0);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attention, setAttention] = useState<Attention>("idle");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setTurns([]);
    setMore(false);
    setAttention("idle");

    // Subscribed before `open()` resolves, on general principle rather than because a race is
    // plausible here: main starts following a session only from `open` (main/conversation.ts), and
    // its poll ticks no faster than once a second, so the first possible append is already far
    // behind this synchronous subscribe. Registering first just means that guarantee is never the
    // reason this is safe.
    const offAppend = window.api.on("conversation:append", (e) => {
      if (cancelled || e.sessionId !== sessionId) return;
      setTurns((prev) => mergeTurns(prev, e.turns, e.restarted));
    });
    // Not gated on this pane being open at all (core/types.ts's own doc on the event) — filtered by
    // sessionId for the same reason the append handler is: this pane can be mounted for one session
    // while another session's conversation is open elsewhere.
    const offAttention = window.api.on("conversation:attention", (e) => {
      if (cancelled || e.sessionId !== sessionId) return;
      setAttention(e.value);
    });

    void window.api.conversation.open(sessionId).then((res) => {
      if (cancelled) return;
      // null is ordinary, not an error: a freshly spawned session has not written a status line yet,
      // and a codex session never will. No retry — the events above are what tells this pane
      // anything changed.
      if (res === null) {
        setStatus("unavailable");
        return;
      }
      setTurns(res.turns);
      setFrom(res.from);
      setMore(res.more);
      setStatus("ready");
    });

    return () => {
      cancelled = true;
      offAppend();
      offAttention();
      void window.api.conversation.close(sessionId);
    };
  }, [sessionId]);

  const loadMore = useCallback(() => {
    if (!more || loadingMore) return;
    setLoadingMore(true);
    void window.api.conversation
      .more(sessionId, from)
      .then((res) => {
        if (res === null) return;
        // Prepend, never replace — `more` never repeats a turn already returned (its own doc
        // comment in core/types.ts), so there is nothing here for mergeTurns's by-id replacement to
        // do. Keeping the reader's scroll position steady across this prepend is a markup concern,
        // hand-checked once this pane is actually mounted (Task 10).
        setTurns((prev) => [...res.turns, ...prev]);
        setFrom(res.from);
        setMore(res.more);
      })
      .finally(() => setLoadingMore(false));
  }, [sessionId, from, more, loadingMore]);

  const messages = useMemo(() => toThreadMessages(turns), [turns]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      // The pty is the only channel there is — a person typing here and a person typing in the
      // terminal are doing the same thing. The typed turn is never pushed into `messages` locally:
      // it comes back through the transcript like every other turn, and adding it here would show
      // it twice.
      window.api.sessions.write(sessionId, composerTextOf(message.content) + "\r");
    },
    [sessionId]
  );

  const Welcome = useCallback(
    (): ReactNode => (
      <div
        data-slot="conversation-pane-empty"
        className="text-muted-foreground px-4 text-center text-sm"
      >
        {t("conversation.empty")}
      </div>
    ),
    [t]
  );

  const Banner = useCallback(
    (): ReactNode => <PendingBanner onGoTerminal={onGoTerminal} />,
    [onGoTerminal]
  );

  const components = useMemo<ThreadComponents>(
    () => ({
      Welcome,
      ToolFallback: ToolRow,
      ToolGroup: ToolRowGroup,
      Banner: attention === "waiting" ? Banner : undefined,
    }),
    [Welcome, Banner, attention]
  );

  // Built unconditionally, ahead of the status branches below — the messages a still-loading or
  // unavailable session has are simply empty, and a hook cannot itself live behind an early return.
  const runtime = useExternalStoreRuntime({
    messages,
    // Required even though `messages` are already ThreadMessageLike: without it the runtime reads
    // `metadata` off a raw message and throws on the first render. Measured, not folklore.
    convertMessage: (m: ThreadMessageLike) => m,
    isDisabled: attention === "waiting",
    isRunning: attention === "working",
    onNew,
  });

  if (status === "unavailable") {
    return (
      <div
        data-slot="conversation-pane-unavailable"
        className="text-muted-foreground flex h-full items-center justify-center px-6 text-center text-sm"
      >
        {t("conversation.unavailable")}
      </div>
    );
  }

  if (status === "loading") {
    // Nothing to draw yet. Showing "unavailable" here would flash wrong for the ordinary case (a
    // session that does have a transcript) while `open` is still in flight.
    return <div data-slot="conversation-pane-loading" className="h-full" />;
  }

  return (
    <div data-slot="conversation-pane" className="flex h-full min-h-0 flex-col">
      {more && (
        <div className="border-border/60 flex justify-center border-b py-1">
          <TooltipIconButton tooltip="Load earlier messages" onClick={loadMore} disabled={loadingMore}>
            <ChevronUpIcon />
          </TooltipIconButton>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread components={components} />
        </AssistantRuntimeProvider>
      </div>
    </div>
  );
}
