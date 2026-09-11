"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { ChevronUpIcon } from "lucide-react";
import { Thread, type ThreadComponents } from "../assistant-ui/elements/thread.aui";
import { Button } from "../ui/button";
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

/**
 * What `turns` becomes after a `conversation:append` event, given which session this pane is
 * showing right now. `conversation:append` and `conversation:attention` both fire for every open
 * session app-wide (core/types.ts's own doc on the events) — two panes can be open on two different
 * sessions at once, and an event meant for one must leave the other's `turns` byte-for-byte alone.
 * Returning the exact same `prev` reference for a foreign session, rather than a fresh but
 * contentically-identical array, is what lets `setTurns`'s own `Object.is` bailout skip re-rendering
 * a pane an event was never about.
 */
export function nextTurnsFor(
  paneSessionId: string,
  prev: ConvTurn[],
  event: { sessionId: string; turns: ConvTurn[]; restarted: boolean }
): ConvTurn[] {
  if (event.sessionId !== paneSessionId) return prev;
  return mergeTurns(prev, event.turns, event.restarted);
}

/**
 * Whether a `conversation:append` event means the paging window (`from`/`more`) should reset to
 * "nothing to page to". True only when the event both belongs to this pane's session and reports a
 * restart — the file was recreated and `JsonlTail` replays it from byte 0
 * (core/rolling/jsonlTail.ts), so `event.turns` is already the whole new conversation and the
 * `from` this pane was holding points into a file that no longer exists at that path.
 */
export function shouldResetPaging(
  paneSessionId: string,
  event: { sessionId: string; restarted: boolean }
): boolean {
  return event.sessionId === paneSessionId && event.restarted;
}

/**
 * What this pane's attention becomes after a `conversation:attention` event, given which session it
 * is showing — `undefined` means "not mine", the caller's cue to leave attention exactly as it is.
 * Same reasoning as `nextTurnsFor`: this event fires for every session app-wide, and a firing for a
 * foreign session must be a complete no-op here.
 */
export function nextAttentionFor(
  paneSessionId: string,
  event: { sessionId: string; value: Attention }
): Attention | undefined {
  return event.sessionId === paneSessionId ? event.value : undefined;
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

  // Bumped by the mount effect on every run, and again in that same run's cleanup — so any callback
  // still holding a past run's captured `generation` value can tell, at any later point, whether the
  // pane has since moved to a different session or unmounted outright. `loadMore` (below, outside
  // this effect) reads and compares the same ref for the identical reason: an in-flight `more()`
  // must never apply a different session's byte offsets to this one.
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    const isCurrent = (): boolean => generationRef.current === generation;

    setStatus("loading");
    setTurns([]);
    setFrom(0);
    setMore(false);
    setAttention("idle");

    // Set once a live push arrives, so the one-shot attention read below (which can resolve after a
    // push that overtook it) never clobbers a value that is already newer than the one it fetched.
    // Which of the two arrived first is an ordering fact about this mount's own event stream, not
    // something either side alone carries, so it stays a plain closure flag rather than folding
    // into `isCurrent`.
    let sawLiveAttention = false;

    // `conversation:attention` only fires on a change, so a session already `waiting` (or
    // `working`) when this pane mounts would otherwise read `idle` until the next change — and for
    // a `waiting` session, blocked on the very prompt this pane exists to surface, that next change
    // may never come (main/ipc.ts's `conversationAttentionOf` doc says the same).
    void window.api.conversation
      .attention(sessionId)
      .then((value) => {
        if (!isCurrent() || sawLiveAttention) return;
        setAttention(value);
      })
      .catch(() => {});

    // Subscribed before `open()` resolves, on general principle rather than because a race is
    // plausible here: main starts following a session only from `open` (main/conversation.ts), and
    // its poll ticks no faster than once a second, so the first possible append is already far
    // behind this synchronous subscribe. Registering first just means that guarantee is never the
    // reason this is safe.
    const offAppend = window.api.on("conversation:append", (e) => {
      if (!isCurrent()) return;
      setTurns((prev) => nextTurnsFor(sessionId, prev, e));
      if (shouldResetPaging(sessionId, e)) {
        setFrom(0);
        setMore(false);
      }
    });
    // Not gated on this pane being open at all (core/types.ts's own doc on the event) —
    // `nextAttentionFor` is what decides whether a given firing is this pane's own session, the
    // same reason `nextTurnsFor` above is: this pane can be mounted for one session while another
    // session's conversation is open elsewhere.
    const offAttention = window.api.on("conversation:attention", (e) => {
      if (!isCurrent()) return;
      const next = nextAttentionFor(sessionId, e);
      if (next === undefined) return;
      sawLiveAttention = true;
      setAttention(next);
    });

    void window.api.conversation
      .open(sessionId)
      .then((res) => {
        if (!isCurrent()) {
          // The pane moved on (a sessionId change, or unmount) before this resolved. main's `open`
          // sets its entry only after its own awaits (main/conversation.ts), so the `close()` this
          // run's own cleanup already fired found nothing to remove yet — closing again now is what
          // actually stops the follow and its 1s ticker for a session this pane no longer shows.
          // React.StrictMode's double-mount runs this exact path on every dev mount and happens to
          // self-heal there, which is exactly why it would go unnoticed without this.
          void window.api.conversation.close(sessionId);
          return;
        }
        // null is ordinary, not an error: a freshly spawned session has not written a status line
        // yet, and a codex session never will. No retry — the events above are what tells this pane
        // anything changed.
        if (res === null) {
          setStatus("unavailable");
          return;
        }
        setTurns(res.turns);
        setFrom(res.from);
        setMore(res.more);
        setStatus("ready");
      })
      .catch(() => {
        if (isCurrent()) setStatus("unavailable");
      });

    return () => {
      generationRef.current += 1;
      offAppend();
      offAttention();
      void window.api.conversation.close(sessionId);
    };
  }, [sessionId]);

  const loadMore = useCallback(() => {
    if (!more || loadingMore) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    void window.api.conversation
      .more(sessionId, from)
      .then((res) => {
        // The pane moved to a different session (or unmounted) while this was in flight —
        // main/conversation.ts's `from`/`more` are byte offsets into *that* session's file, and
        // applying them here would prepend an arbitrary slice of a file this pane no longer shows.
        if (generationRef.current !== generation) return;
        if (res === null) return;
        // Prepend, never replace — `more` never repeats a turn already returned (its own doc
        // comment in core/types.ts), so there is nothing here for mergeTurns's by-id replacement to
        // do. Keeping the reader's scroll position steady across this prepend is a markup concern,
        // hand-checked once this pane is actually mounted (Task 10).
        setTurns((prev) => [...res.turns, ...prev]);
        setFrom(res.from);
        setMore(res.more);
      })
      .catch(() => {})
      .finally(() => {
        if (generationRef.current === generation) setLoadingMore(false);
      });
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
    // `isDisabled` does reach the composer's actual <textarea> — assistant-ui's
    // useComposerInputDisabled (useComposerInputState.js) ORs it with a `disabled` prop, and
    // ComposerInput.js applies the result — so this is the real lock, not a stand-in for one.
    isDisabled: attention === "waiting",
    // No `isRunning`. In assistant-ui it means "a run this component controls is in progress, with
    // a cancel path" — we have neither: the CLI owns the run, and there is no `onCancel` to give
    // this adapter. Setting it true while `working` swallows Enter, hides Send behind
    // `!thread.isRunning`, and leaves Cancel rendered but disabled (no `capabilities.cancel`) — a
    // person could type but never send, for most of an agent's working life. The CLI itself accepts
    // typing while it works; blocking here would make this view worse at its one job than the
    // terminal it sits beside. The live marker on an unfinished tool row (ToolRow.tsx,
    // `result === undefined`) already carries "something is happening" — `attention` itself still
    // drives the banner and the real lock while `waiting`.
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

  const locked = attention === "waiting";

  return (
    <div data-slot="conversation-pane" className="flex h-full min-h-0 flex-col">
      {more && (
        <div className="border-border/60 flex justify-center border-b py-1">
          <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
            <ChevronUpIcon />
            {t("conversation.loadMore")}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread components={components} composerPlaceholder={t("conversation.composer.placeholder")} />
        </AssistantRuntimeProvider>
      </div>
      {/* The banner above already says an answer is waiting; this says why the input itself went
          quiet, right where a person's eye lands after finding out typing did nothing. */}
      {locked && (
        <div
          data-slot="conversation-pane-locked"
          className="text-muted-foreground border-border/60 border-t px-4 py-1.5 text-center text-xs"
        >
          {t("conversation.composer.locked")}
        </div>
      )}
    </div>
  );
}
