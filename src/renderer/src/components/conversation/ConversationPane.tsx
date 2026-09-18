"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Loader2Icon } from "lucide-react";
import { Thread, type ThreadComponents } from "../assistant-ui/elements/thread.aui";

/** The composer belongs to this subtree, and a controlled input that re-renders while a character is
 *  on its way in can be handed back the value it had a moment ago — which is a keystroke lost. The
 *  menu below changes on every key, so the menu must not be able to re-render this: its rows travel
 *  by context to a slot inside, and everything else this takes is stable. */
const MemoThread = memo(Thread);
import { ToolRow, ToolRowGroup } from "./ToolRow";
import { ChatNotice, ExitedNotice, RunningNotice } from "./PendingBanner";
import { ModelControl, type ModelControlProps } from "./ModelControl";
import { effortChoicesOf, modelChoicesOf } from "../../../../core/models/cliModels";
import type { ModelDescriptor } from "../../../../core/models/types";
import { CompletionMenu, type CompletionRow } from "./CompletionMenu";
import { fileTokenAt } from "../../../../core/files/fileMatch";
import { draftOf, forgetDraft, keepDraft } from "./drafts";
import {
  isAwaitingReply,
  isWorkingNow,
  sendPending,
  unsettledSends,
  dropPending,
  type PendingSend
} from "../../../../core/history/pendingSends";
import { ChatRequestCard } from "./ChatRequestCard";
import { useChatState } from "../../hooks/useChatState";
import { toast } from "../../lib/toast";
import { useI18n } from "../../i18n/I18nProvider";
import type { ConvPart, ConvTurn } from "../../../../core/history/convTypes";
import type { RollStateEvent, SchedStateEvent } from "../../../../core/types";
import { chatBannerFor, composerLockedFor } from "./paneTransport";
import { SessionStateBanners, stateBannerHeight } from "../SessionStateBanners";

export interface ConversationPaneProps {
  sessionId: string;
  /** The session has ended. Its pty is gone, so the composer is shut and the pane says so rather than
   *  taking words for a process that cannot hear them — the terminal beside it has the restart. */
  exited?: boolean;
  /** This pane is the window's active one and is the one showing. Mirrors TerminalView's prop of the
   *  same name, and exists for the same reason: `pane.focusLeft`/`Right`/`Up`/`Down` only move which
   *  pane is active, and it is each pane's own job to take the caret. Without this, moving to a
   *  neighbouring conversation left the caret in the pane you came from — the marker said one session
   *  and the typing went to another. */
  active?: boolean;
  /** The rolling and schedule banners (chat-sessions slice 4 §5.6): PaneGrid passes the per-session
   *  events it already holds for TerminalView. Absent for a terminal session's conversation view — its
   *  TerminalView shows them. */
  rollState?: RollStateEvent | null;
  schedState?: SchedStateEvent | null;
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

function isTextPart(part: { type: string; text?: string }): part is { type: "text"; text: string } {
  return part.type === "text";
}

export function composerTextOf(parts: AppendMessage["content"]): string {
  return parts.filter(isTextPart).map((part) => part.text).join("");
}

/**
 * Whether an `open` that resolved after its own run ended should close the session it opened.
 *
 * Only when no later run of the same pane is mounted for that session. main keys its follow by
 * session id and nothing else, so a close sent for a session a newer run has already opened takes
 * that newer follow with it: the pane keeps the turns it drew, and never hears another thing —
 * no live append, and `more` answers null so "load earlier" does nothing at all, silently.
 *
 * Two opens for one session overlap whenever the pane remounts before the first resolves: every
 * React.StrictMode double-mount in development, and a quick toggle out and back in anywhere. The
 * second open resolves first often enough for this to be the common case, not the rare one — it
 * was measured losing three mounts out of four.
 */
export function shouldCloseStaleOpen(mountedFor: string | null, sessionId: string): boolean {
  return mountedFor !== sessionId;
}

/** How near the top counts as having arrived there. The same allowance HistoryBrowser's own infinite
 *  scroll gives its sentinel, so the earlier window is on its way before the reader runs out of page
 *  rather than after. */
export const LOAD_EARLIER_MARGIN_PX = 120;

/**
 * Whether the earlier window should be fetched now.
 *
 * The second branch is what replaces the button rather than merely automating it. A window shorter
 * than the viewport has no scrollbar, so no scroll event can ever arrive and the reader has nothing
 * to drag: with the button gone that is a conversation whose start cannot be reached at all. Paging
 * on that condition fills the viewport and then stops, because once there is a scrollbar the first
 * branch takes over.
 *
 * It also settles the frame between a pane rendering its first window and the thread scrolling to the
 * bottom. The viewport reads as scrolled to the top for that frame, but it already overflows, so the
 * first branch is the one consulted and it says no.
 */
export function shouldLoadEarlier(v: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  more: boolean;
  loadingMore: boolean;
}): boolean {
  if (!v.more || v.loadingMore) return false;
  if (v.scrollHeight <= v.clientHeight) return true;
  return v.scrollTop <= LOAD_EARLIER_MARGIN_PX;
}


/**
 * What to call the session's model before the CLI has said which one it is running.
 *
 * `configuredModel` is what the account's own settings choose (core/models/parse.ts's
 * `configuredModelOf`), and it wins, because a chat session is launched without `--model` and the CLI
 * therefore runs exactly that. It is resolved through the list rather than shown as written: the
 * settings say `claude-fable-5-1[1m]` where `system/init` says `claude-fable-5-1`, both measured, so
 * going through the list is what makes the label stop changing when the first turn finally reports it.
 * A chosen model the list does not carry is still the right answer and is shown as written.
 *
 * The list's `default` entry is the fallback, and only that. It describes what the default *option*
 * means, not what this session is set to, so naming it while the settings had chosen something else
 * was simply wrong: on an account whose settings chose Fable the composer read "Default (recommended)"
 * and the first turn came back Fable. With nothing chosen the CLI really does use the default, and
 * then the entry is the right thing to name.
 *
 * Why any of this is needed: `system/init`, where a Claude chat session's model comes from, does not
 * arrive at the handshake -- measured, a process sat 90 s without one while answering a `list_models`
 * control request in 1.3 s. It arrives with the first turn. The model list carries no marker for the
 * model in use and the initialize response carries no model at all, so the settings are the only
 * source there is until then.
 */
export function pendingModelLabelOf(
  models: readonly ModelDescriptor[],
  configuredModel: string | null
): string | null {
  const entry = models.find((m) => (configuredModel === null ? m.isDefault : m.id === configuredModel))
  if (entry === undefined) return configuredModel
  return entry.resolvedModel ?? entry.name
}

/**
 * The one-line label for what the CLI is running under, or null when it has told us nothing worth
 * drawing. Effort alone is not worth a line: it means nothing without the model it belongs to.
 *
 * `fallbackModel` is what to draw while the CLI has reported no model at all — for a chat session,
 * `pendingModelLabelOf` above, which names the model the account's settings choose.
 * Without it a freshly opened chat pane sits on the bare "model" placeholder until someone sends
 * something, because Claude names its model only on `system/init` and that arrives with the first
 * turn. Drawn alone: an effort with no reported model still belongs to nothing.
 */
export function modelLineOf(
  info: { model: string | null; effort: string | null },
  format: (model: string, effort: string) => string,
  fallbackModel: string | null = null
): string | null {
  if (info.model === null) return fallbackModel === null ? null : shortModelName(fallbackModel);
  const model = shortModelName(info.model);
  if (info.effort === null) return model;
  return format(model, info.effort);
}

/** A model id as this app says it. Every Claude id carries the vendor's own name in front, and inside
 *  this app that is never the question — a session belongs to one CLI or the other and the pane
 *  already says which — so it is a third of a narrow button spent on nothing. Only that exact word and
 *  only at the front: `my-claude-fork` and a model called `claude` are left alone, and codex's names
 *  never had it. */
function shortModelName(model: string): string {
  return model.startsWith(VENDOR_PREFIX) ? model.slice(VENDOR_PREFIX.length) : model;
}

const VENDOR_PREFIX = "claude-";


/** How long to keep looking for the composer to put an unsent draft back into. It is a child of the
 *  Thread, which mounts a moment after this pane does. */
const DRAFT_RESTORE_MS = 80
const DRAFT_RESTORE_TRIES = 25

/** How long a message shown before the transcript carries it may stay that way, and how often that is
 *  checked. A message can be swallowed by a dialog the CLI had open and never recorded at all, and a
 *  bubble that stayed forever would be a worse lie than the delay it exists to cover. */
const PENDING_MAX_MS = 60_000
const PENDING_SWEEP_MS = 5_000

/** How long the button may say a change is on its way before giving up on saying so. Longer than the
 *  walk's own wait, so an answer that is merely slow still lands while it is still being waited for,
 *  and short enough that a change the CLI quietly refused stops pretending. */
const MODEL_BUSY_MAX_MS = 6_000


/** How often a pane with nothing to show asks again whether a transcript has appeared. */
const UNAVAILABLE_RETRY_MS = 2_000;

/** How long a pending scroll correction stays armed. Long enough for the thread's own render pass to
 *  land the prepended messages, short enough that an unrelated later resize cannot inherit it. */
const RESTORE_SCROLL_DEADLINE_MS = 1_500;

/** The thread's own scrolling element. `data-slot` rather than a class: the slot attribute is set by
 *  the vendored thread in this repository, so it is ours to depend on, while the classes beside it
 *  come from upstream and change with it. */
function threadViewport(pane: HTMLElement | null): HTMLElement | null {
  return pane?.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]') ?? null;
}

/**
 * The composer's model control, as a component type that never changes.
 *
 * The Thread takes its slots as component *types*, and React unmounts and remounts a slot the moment
 * that type changes identity. A `useCallback` here looked stable and was not: its dependencies reach
 * PaneGrid's inline `onGoTerminal`, which is a new function on every App render, so the slot was
 * rebuilt a few times a second and the open menu inside it died with each rebuild — pressed once, gone
 * before a choice could be made. So the type is fixed at module scope and everything that does change
 * arrives through context, which re-renders the control instead of replacing it.
 */
const ModelSlotContext = createContext<ModelControlProps | null>(null);

/** The banner slot's contents, for the same reason the model slot has one: a slot rebuilt on every
 *  render is unmounted and remounted on every keystroke, and React churning the composer's own
 *  neighbours while someone is typing into it is not something to leave in place and hope about. */
const BannerSlotContext = createContext<ReactNode>(null);

/** Always mounted, and empty when there is nothing to say. Handing the Thread a slot that comes and
 *  goes would change its `components` the moment a menu opens, which re-renders the composer at the
 *  exact instant a character is arriving in it. */
function ConversationBannerSlot(): ReactNode {
  return useContext(BannerSlotContext);
}

/** Whether the mark at the end of the output is up, and which state it names. Its own context for the
 *  same reason the two above have one: the slot is a component *type* the Thread holds on to, so it is
 *  fixed at module scope and everything that changes arrives through here. */
const RunningSlotContext = createContext<{
  show: boolean;
  working: boolean;
  onStop: () => void;
}>({ show: false, working: false, onStop: () => {} });

function ConversationRunningSlot(): ReactNode {
  const { show, working, onStop } = useContext(RunningSlotContext);
  if (!show) return null;
  return <RunningNotice working={working} onStop={onStop} />;
}

function ComposerModelSlot(): ReactNode {
  const props = useContext(ModelSlotContext);
  // Drawn as soon as the CLI is known. For a terminal session that is the session's account; for a
  // chat session it is the manager's word (`chat.provider`), which is null for the moment before
  // `chat.state` answers. What the CLI is *set to* can genuinely be unknown for longer — codex
  // reports its model a turn at a time, so a session that has not answered anything yet has none to
  // report — and that is no reason to withhold the menu: the choices are the CLI's own either way,
  // and the readout says it does not know yet. Nothing is drawn while `cli` is null — the account is
  // gone, or the manager has not said yet — because the two CLIs' menus are not interchangeable and
  // a placeholder would show one CLI's menu for the other.
  if (props === null || (props.cli !== 'claude' && props.cli !== 'codex')) return null;
  return <ModelControl {...props} />;
}

// ---- the chat transport's failures ------------------------------------------------------------

/** What a rejected `window.api.chat.*` call reads as. An Error's own words when it has them, since
 *  main puts the adapter's reason there, and the value itself otherwise. */
function chatErrorText(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}

/** Says so when a fire-and-forget `chat.*` call fails.
 *
 *  Every call the model menu makes is answered by an event rather than by its own promise, so there is
 *  nothing waiting on the returned promise to notice a rejection — and a model that never changed,
 *  with nothing said, looks exactly like a menu that ignored the press. */
function sayIfFailed(call: Promise<void>): void {
  void call.catch((err: unknown) => toast.error(chatErrorText(err)));
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
export function ConversationPane({
  sessionId,
  active = false,
  exited = false,
  rollState = null,
  schedState = null
}: ConversationPaneProps): ReactNode {
  const { t } = useI18n();
  /** This session's whole state — status, the request it is waiting on, its model, the last turn's
   *  error — folded from `chat.state` and the `chat:event` stream (hooks/useChatState.ts). Null until
   *  that first answer lands. */
  const chat = useChatState(sessionId, true);
  /** `chat.status` without the optional chain, so the dependency arrays below stay plain reads. */
  const chatStatus = chat === null ? null : chat.status;
  const [status, setStatus] = useState<Status>("loading");
  const [turns, setTurns] = useState<ConvTurn[]>([]);
  const [from, setFrom] = useState(0);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // What the composer holds right now, tracked by listening to it rather than asking the runtime: the
  // input is assistant-ui's, `input` events bubble to this pane's own root, and that is the whole of it.
  const [composerText, setComposerText] = useState("");
  const [composerCaret, setComposerCaret] = useState(0);
  const [fileMatches, setFileMatches] = useState<readonly string[]>([]);
  const [slashActive, setSlashActive] = useState(0);
  /** What this session's CLI says it can run. Asked once per session — see conversation.models. */
  const [models, setModels] = useState<readonly ModelDescriptor[]>([]);
  /** The model this session's own settings choose, for the composer to name before the first turn —
   *  see pendingModelLabelOf. Asked once beside the model list, and null until the answer lands. */
  const [configuredModel, setConfiguredModel] = useState<string | null>(null);
  /** What the model readout and its menu are looking at. It comes from the manager, which is the only
   *  thing that knows — there is no screen to read and the rollout is a turn behind. `cli` is the
   *  session's own provider once the manager has said (`chat.state`), and null until then: the two
   *  CLIs' menus are not interchangeable, so the control is drawn only once it is known which one this
   *  is (ComposerModelSlot), rather than guessed at for the moment before the answer lands. */
  const modelInfo = {
    model: chat === null ? null : chat.model.model,
    effort: chat === null ? null : chat.model.effort,
    cli: chat === null ? null : chat.provider
  };

  // Bumped by the mount effect on every run, and again in that same run's cleanup — so any callback
  // still holding a past run's captured `generation` value can tell, at any later point, whether the
  // pane has since moved to a different session or unmounted outright. `loadMore` (below, outside
  // this effect) reads and compares the same ref for the identical reason: an in-flight `more()`
  // must never apply a different session's byte offsets to this one.
  const generationRef = useRef(0);
  // Which session this pane is mounted for at this instant, or null while it is unmounted. Read only
  // by the stale branch of `open` below — see shouldCloseStaleOpen for what it is deciding and why
  // the generation alone cannot decide it.
  const mountedForRef = useRef<string | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

  // Takes the caret when this pane becomes the active one, the way TerminalView focuses its xterm for
  // the same prop. Keyed on `active` alone, so it fires on the transition rather than on every render:
  // pressing a choice button or the model picker inside the pane must not yank the caret back.
  //
  // The composer is looked up rather than held in a ref — assistant-ui owns that <textarea> and gives
  // no ref for it. A miss (still mounting, or disabled while the folder-trust prompt is up) is fine:
  // focusing nothing is what should happen there anyway.
  useEffect(() => {
    if (!active) return;
    const ta = paneRef.current?.querySelector("textarea");
    if (ta && !ta.disabled) ta.focus();
  }, [active]);
  // Whether the last keystroke left the composer in a state a menu cares about — see the input
  // listener, which uses it to stay silent for ordinary typing.
  const triggerArmedRef = useRef(false);
  /**
   * What the composer holds right now, or null when this mount has not seen it hold anything.
   *
   * A ref, and written on every keystroke before the listener below decides whether anything else is
   * worth doing: assigning to it renders nothing, and the one place that needs it is a cleanup that
   * runs when the composer is already gone. React detaches refs and removes the DOM before a passive
   * effect's cleanup runs, so reading the textarea there finds nothing — measured, and it is why the
   * first version of the draft kept nothing at all.
   *
   * Null rather than an empty string, because the two mean different things to the draft below. An
   * empty string is "someone cleared it", which throws the draft away. Null is "nobody typed here",
   * which leaves it alone — and that is what StrictMode's extra mount/cleanup pair is, so without the
   * distinction every mount deleted the draft the last unmount had just saved. Worse, StrictMode
   * doubles effects in development only, so drafts would have worked in a packaged build and not
   * while anyone was working on them.
   */
  const composerValueRef = useRef<string | null>(null);
  /** The pending 'where did it go' notice, cancelled the moment anything comes back. */
  const slashSilenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the thread's scroll looked like just before a load-earlier prepend, so the layout effect
  // below can put the reader back where they were. Null except between that prepend and its
  // correction.
  const restoreScrollRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
    deadline: number;
  } | null>(null);

  useEffect(() => {
    const generation = ++generationRef.current;
    const isCurrent = (): boolean => generationRef.current === generation;
    mountedForRef.current = sessionId;

    setStatus("loading");
    setTurns([]);
    setFrom(0);
    setMore(false);
    setComposerText("");
    composerValueRef.current = null;
    setComposerCaret(0);
    setFileMatches([]);
    setSlashActive(0);
    setSlashDismissed(false);

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
    void window.api.conversation
      .open(sessionId)
      .then((res) => {
        if (!isCurrent()) {
          // The pane moved on (a sessionId change, or unmount) before this resolved. main's `open`
          // sets its entry only after its own awaits (main/conversation.ts), so the `close()` this
          // run's own cleanup already fired found nothing to remove yet — closing now is what
          // actually stops the follow and its 1s ticker for a session this pane no longer shows.
          if (shouldCloseStaleOpen(mountedForRef.current, sessionId)) {
            void window.api.conversation.close(sessionId);
          }
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
      // Whatever is in the composer goes with the session, not with the pane. This runs on a
      // sessionId change and on unmount, which between them are every way a composer disappears.
      if (composerValueRef.current !== null) keepDraft(sessionId, composerValueRef.current);
      generationRef.current += 1;
      mountedForRef.current = null;
      if (slashSilenceRef.current !== null) clearTimeout(slashSilenceRef.current);
      slashSilenceRef.current = null;
      offAppend();
      void window.api.conversation.close(sessionId);
    };
  }, [sessionId]);

  // `open` answering null is a moment, not a verdict. A session that has only just started reports
  // its transcript path a beat after it comes up, and a session resumed from history does the same —
  // it keeps the id and the file it is resuming, so the whole earlier conversation is there as soon
  // as the path arrives. The pane used to latch on to that first null for the rest of the tab's life,
  // and it hid the composer while doing it, so someone who opened the view a second too early was
  // left with a dead panel and no way to type. Retried here rather than followed in main because a
  // fresh `open` is what carries the paging window that an append event has no room for. It keeps
  // asking for as long as the pane is open and empty, which for a codex session is forever: one small
  // file read every couple of seconds while a person is looking at an empty panel, and the
  // alternative is that dead end again.
  useEffect(() => {
    if (status !== "unavailable") return;
    const generation = generationRef.current;
    const timer = setInterval(() => {
      void window.api.conversation
        .open(sessionId)
        .then((res) => {
          if (generationRef.current !== generation) {
            // Same reasoning as the mount effect's own stale branch, and the same guard.
            if (shouldCloseStaleOpen(mountedForRef.current, sessionId)) {
              void window.api.conversation.close(sessionId);
            }
            return;
          }
          if (res === null) return;
          setTurns(res.turns);
          setFrom(res.from);
          setMore(res.more);
          setStatus("ready");
        })
        .catch(() => {});
    }, UNAVAILABLE_RETRY_MS);
    return () => clearInterval(timer);
  }, [sessionId, status]);

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
        // do.
        const viewport = threadViewport(paneRef.current);
        restoreScrollRef.current =
          viewport && res.turns.length > 0
            ? {
                scrollHeight: viewport.scrollHeight,
                scrollTop: viewport.scrollTop,
                deadline: Date.now() + RESTORE_SCROLL_DEADLINE_MS
              }
            : null;
        setTurns((prev) => [...res.turns, ...prev]);
        setFrom(res.from);
        setMore(res.more);
      })
      .catch(() => {})
      .finally(() => {
        if (generationRef.current === generation) setLoadingMore(false);
      });
  }, [sessionId, from, more, loadingMore]);

  // Content arriving above the reader would otherwise slide everything they were looking at down by
  // its own height: the thread manages its own scrolling, which suppresses the browser's scroll
  // anchoring, so nothing compensates on its own. Measured before this: a prepend moved the reader's
  // line down by exactly what was added, and a whole earlier window is a screenful or more.
  //
  // Driven by the thread growing rather than by `turns` changing, because those are not the same
  // moment: the runtime hands the prepended messages to the thread, which renders them in a later
  // pass, so a layout effect on `turns` measures a viewport that has not grown yet and corrects by
  // nothing at all. The first firing is often the load-earlier bar disappearing, which shrinks the
  // content — hence waiting for a net gain rather than acting on the first change, and a deadline so
  // a prepend that never lands cannot leave a correction armed for the next unrelated resize.
  useLayoutEffect(() => {
    const viewport = threadViewport(paneRef.current);
    const content = viewport?.firstElementChild;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => {
      const pending = restoreScrollRef.current;
      if (!pending) return;
      if (Date.now() > pending.deadline) {
        restoreScrollRef.current = null;
        return;
      }
      const grew = viewport.scrollHeight - pending.scrollHeight;
      if (grew <= 0) return;
      restoreScrollRef.current = null;
      // The viewport scrolls smoothly by default, which would animate this correction into the very
      // lurch it exists to remove.
      const behaviour = viewport.style.scrollBehavior;
      viewport.style.scrollBehavior = "auto";
      viewport.scrollTop = pending.scrollTop + grew;
      viewport.style.scrollBehavior = behaviour;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [status]);

  // Paging upward, the way the history list pages downward. The scroll listener covers the ordinary
  // case; the call on attach covers the one no scroll event can reach, where the window on screen is
  // shorter than the viewport (see shouldLoadEarlier). `turns` is in the dependencies for the same
  // reason — a prepend that still does not fill the viewport has to ask again, or paging stalls one
  // window short of the start.
  useEffect(() => {
    const viewport = threadViewport(paneRef.current);
    if (!viewport) return;
    const check = (): void => {
      if (
        shouldLoadEarlier({
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
          more,
          loadingMore
        })
      ) {
        loadMore();
      }
    };
    check();
    // Passive: this only reads the viewport, and saying so keeps it off the scrolling path.
    viewport.addEventListener("scroll", check, { passive: true });
    return () => viewport.removeEventListener("scroll", check);
  }, [status, turns, more, loadingMore, loadMore]);

  /** Sent, and not yet seen come back in the transcript — see core/history/pendingSends.ts. */
  const [pending, setPending] = useState<readonly PendingSend[]>([]);

  // Settled by the transcript growing the turn, and given up on when it never does. Both are decided
  // in one place; this only re-decides it when there is something to decide.
  useEffect(() => {
    if (pending.length === 0) return;
    const settle = (): void =>
      setPending((prev) => {
        const next = unsettledSends(prev, turns, Date.now(), PENDING_MAX_MS);
        return next.length === prev.length ? prev : next;
      });
    settle();
    const timer = setInterval(settle, PENDING_SWEEP_MS);
    return () => clearInterval(timer);
  }, [pending, turns]);

  const messages = useMemo(
    () => [
      ...toThreadMessages(turns),
      // The person's own words, shown before the CLI writes them down. The transcript is still the
      // only place a turn really exists — this is a copy that lives exactly as long as it takes the
      // real one to arrive.
      ...pending.map((p) => ({
        id: p.id,
        role: "user" as const,
        content: [{ type: "text" as const, text: p.text }]
      }))
    ],
    [turns, pending]
  );

  /**
   * Presses Escape on the CLI, which is what a person reaches for to stop it mid-turn.
   *
   * Written straight to the pty rather than dressed up as a cancel: the terminal beside this view
   * interrupts with exactly this keypress, and the CLI owns what it means — stop the turn, close the
   * dialog it has up, whatever it is doing. A cancel of our own would have to guess at that and would
   * be wrong the moment the CLI changed its mind about any of it.
   */
  const interruptRef = useRef<() => void | Promise<void>>(() => {});
  const isRunningRef = useRef(false);
  const sendTextRef = useRef<(text: string) => void | Promise<void>>(() => {});

  const interrupt = useCallback(async (): Promise<void> => {
    // The stop is a request on the app-server, and the manager answers it with a status the pane
    // hears back as an event.
    //
    // Said out loud when it fails, the way a send is: this is called as `void interruptRef.current()`
    // and as the composer's own `onCancel`, so a rejection nobody catches is a stop that silently did
    // not happen while the turn goes on running.
    try {
      await window.api.chat.interrupt(sessionId);
    } catch (err) {
      toast.error(chatErrorText(err));
    }
  }, [sessionId]);
  interruptRef.current = interrupt;

  const sendText = useCallback(
    async (text: string) => {
      // The turn goes to the app-server, and nothing here reads a screen on the way: there is none.
      // `chat.send` rejects when the turn cannot start (a turn already running, the process gone),
      // and that rejection is the only thing worth saying.
      //
      // The person's own words are shown straight away. The turn only really exists once the CLI
      // writes it into the rollout, and until then they are nowhere on screen. The wait is not small.
      // Claude flushes the user record within a moment, but codex writes it when the turn it started
      // gets going — measured across this machine's last twelve rollouts, a median of 0.6 s and up to
      // 3.8 s after the turn begins — and the view reads the file on a one-second poll on top of
      // that. Someone watching several seconds of nothing after pressing Enter reads it as a send
      // that failed, and reported it as one.
      //
      // The copy is set before the request rather than after it, because the request is itself part
      // of the wait: codex's `turn/start` is awaited here. It lives exactly as long as it takes the
      // real turn to arrive — pendingSends.ts settles it against the transcript, so the bubble is
      // replaced by the record it was standing in for, never shown twice.
      const echoId = crypto.randomUUID();
      setPending((prev) => sendPending(prev, turns, text, echoId, Date.now()));
      try {
        await window.api.chat.send(sessionId, text);
      } catch (err) {
        // Refused, so nothing was sent and the copy has to go with the toast rather than sit there
        // for a minute claiming otherwise. The text is still in the person's hands — the composer
        // cleared, but the draft below was not thrown away, so leaving the tab and coming back
        // offers it again to retry with.
        setPending((prev) => dropPending(prev, echoId));
        toast.error(chatErrorText(err));
        return;
      }
      // It was sent; there is nothing left to put back. Without these two the pane's own cleanup
      // writes the sent text back as this session's draft (`keepDraft`) and the next mount inserts
      // it into the composer — a message already answered, sitting there ready to be sent twice.
      forgetDraft(sessionId);
      composerValueRef.current = null;
    },
    [sessionId, turns]
  );
  sendTextRef.current = sendText;

  const onNew = useCallback(
    async (message: AppendMessage) => sendText(composerTextOf(message.content)),
    [sendText]
  );

  // The margin on this is what keeps it off the composer: an empty thread centres its whole column,
  // so without one the line and the box below it end up touching.
  const Welcome = useCallback(
    (): ReactNode => (
      <div
        data-slot="conversation-pane-empty"
        className="text-muted-foreground mb-12 px-4 text-center text-sm"
      >
        {t(status === "unavailable" ? "conversation.unavailable" : "conversation.empty")}
      </div>
    ),
    [t, status]
  );

  // Escape closes the menu without closing anything else; it reopens the moment the text changes,
  // which is what a person means by dismissing a suggestion rather than abandoning the command.
  // State, not a ref: the listener below sets it, and only a state change redraws the banner slot.
  const [slashDismissed, setSlashDismissed] = useState(false);
  // No `/` rows here: those commands are the CLI's own, run by typing them at a prompt this session
  // does not have. `@` file rows stay — they are only text, and the path they put in the message is
  // read by whatever is on the other end either way.
  const fileToken = slashDismissed ? null : fileTokenAt(composerText, composerCaret);
  const fileQuery = fileToken === null ? null : fileToken.query;

  // What `@` is asking for, fetched per keystroke. Cheap after the first one: main walks the project
  // once and keeps the list (main/fileIndex.ts), so this is an in-memory filter and a round trip.
  useEffect(() => {
    if (fileQuery === null) {
      setFileMatches([]);
      return;
    }
    const generation = generationRef.current;
    let cancelled = false;
    void window.api.conversation
      .files(sessionId, fileQuery)
      .then((paths) => {
        if (cancelled || generationRef.current !== generation) return;
        setFileMatches(paths);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, fileQuery]);

  const rows: CompletionRow[] =
    fileToken === null ? [] : fileMatches.map((p) => ({ key: p, label: p }));
  const slashOpen = rows.length > 0;
  const slashOpenRef = useRef(slashOpen);
  slashOpenRef.current = slashOpen;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const slashActiveRef = useRef(slashActive);
  slashActiveRef.current = slashActive;

  /** Puts a chosen command on the line, in place of the token that was being typed. Written through
   *  `insertText` rather than by setting `value`: the input belongs to assistant-ui's own store, and
   *  only a real edit event reaches it. */
  /** Put text into the composer as though it had been typed. `insertText` rather than an assignment
   *  for the reason the completion menu gives: the composer is a controlled input, and only a real
   *  edit reaches the store behind it. */
  const insertIntoComposer = useCallback((text: string): void => {
    const input = paneRef.current?.querySelector("textarea");
    if (!input) return;
    input.focus();
    document.execCommand("insertText", false, text);
  }, []);

  /**
   * A file dropped on this pane, or an image pasted into it, becomes a path in the message.
   *
   * That is the only form a pty takes: it carries characters, so there is no way to hand a CLI an
   * image except to tell it where one is. Both CLIs read a path, and putting it in the composer
   * rather than somewhere invisible means the person sees exactly what is about to be sent and can
   * write a sentence around it.
   *
   * A file dragged from the filesystem already has a path, and that one is used as it is — copying it
   * would leave a second, stale version of a file the CLI could have read where it lay. Only
   * something with no path of its own (a clipboard image) is written out.
   */
  const attachFile = useCallback(
    async (file: File): Promise<void> => {
      const existing = window.api.files.pathForFile(file);
      if (existing !== "") {
        insertIntoComposer(`${existing.replaceAll("\\", "/")} `);
        return;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const saved = await window.api.conversation.attach(
        sessionId,
        file.name,
        file.type,
        dataUrl.slice(dataUrl.indexOf(",") + 1)
      );
      insertIntoComposer(`${saved} `);
    },
    [insertIntoComposer, sessionId]
  );

  /** Files out of a drop or a paste, in the order they came. Empty for anything else, which is what
   *  lets ordinary text paste through untouched. */
  const onComposerFiles = useCallback(
    (files: readonly File[]): void => {
      if (files.length === 0) return;
      void (async () => {
        for (const file of files) {
          try {
            await attachFile(file);
          } catch {
            // One that cannot be saved is skipped; the rest still go in, and the CLI's own screen is
            // still there for anything this cannot carry.
          }
        }
      })();
    },
    [attachFile]
  );

  const takeRow = useCallback((row: CompletionRow): void => {
    const input = paneRef.current?.querySelector("textarea");
    if (!input) return;
    input.focus();
    const token = fileTokenAt(input.value, input.selectionStart ?? input.value.length);
    if (row.label.startsWith("/")) {
      // A command is the whole line, so the whole line is what it replaces.
      input.setSelectionRange(0, input.value.length);
      document.execCommand("insertText", false, `${row.label} `);
    } else if (token !== null) {
      // A file reference is one word inside a sentence: only the `@…` being typed is replaced.
      input.setSelectionRange(token.start, input.selectionStart ?? input.value.length);
      document.execCommand("insertText", false, `@${row.label} `);
    }
    setSlashDismissed(true);
  }, []);

  const takeRowRef = useRef(takeRow);
  takeRowRef.current = takeRow;

  // The composer is assistant-ui's, so this listens to it from the outside: `input` bubbles up to this
  // pane's root, and the keys the menu needs are caught on the way down, before the composer's own
  // Enter can send a half-typed command as a message.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const onInput = (e: Event): void => {
      const target = e.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      // A key that cannot open, close or narrow a menu changes nothing here, so it sets no state and
      // causes no render. That is most of what anyone types, and every render this pane makes while a
      // character is on its way into the composer is a chance to hand the composer back the value it
      // had a moment ago.
      const value = target.value;
      composerValueRef.current = value; // see the ref's own note: no render, and the draft needs it
      const caret = target.selectionStart ?? value.length;
      const couldTrigger = value.startsWith("/") || fileTokenAt(value, caret) !== null;
      if (!couldTrigger && !triggerArmedRef.current) return;
      triggerArmedRef.current = couldTrigger;
      // Deferred: this listener sits on the pane, which is inside React's own root, so a state update
      // made here lands in the middle of the keystroke's dispatch. A microtask puts it after every
      // handler for that event, which is where a bystander belongs.
      queueMicrotask(() => {
        setSlashDismissed(false);
        setComposerText(value);
        setComposerCaret(caret);
        setSlashActive(0);
      });
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      // Escape goes to the CLI, the same key that stops it in the terminal — unless our own menu is
      // open, which takes it first (below) to close itself, the way every menu does.
      // Enter, while the CLI is working, still sends. assistant-ui stops sending once `isRunning` is
      // set — which it is, so that the composer's own button can offer to stop — and the CLI itself
      // takes messages while it works and queues them (the notice above says so when it does). Losing
      // that to a button label would make this view worse than the terminal at the one thing it is
      // for, so the key is handled here and the button keeps its new job.
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !slashOpenRef.current &&
        isRunningRef.current
      ) {
        const box = e.target instanceof HTMLTextAreaElement ? e.target : null;
        const text = box?.value.trim() ?? "";
        if (box && text !== "") {
          e.preventDefault();
          e.stopPropagation();
          box.select();
          document.execCommand("insertText", false, ""); // clears it the way the composer expects
          void sendTextRef.current(text);
          return;
        }
      }
      if (e.key === "Escape" && !slashOpenRef.current) {
        e.preventDefault();
        e.stopPropagation();
        void interruptRef.current();
        return;
      }
      if (!slashOpenRef.current) return;
      const matches = rowsRef.current;
      if (matches.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setSlashActive((i) => (i + step + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        takeRowRef.current(matches[Math.min(slashActiveRef.current, matches.length - 1)]);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        takeRowRef.current(matches[Math.min(slashActiveRef.current, matches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSlashDismissed(true);
        setSlashActive(0);
      }
    };
    // A click on the conversation puts the caret back in the composer. Without it the focus sits on
    // whatever was clicked — the thread, a tool row, the toggle — and the next thing typed goes
    // nowhere, which reads as the first character being eaten. Not for a click on something that
    // takes input or acts on its own: a button, a link, the menu.
    const onPointerUp = (e: MouseEvent): void => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest("button, a, input, textarea, [role='option'], [role='menuitem']")) return;
      if (window.getSelection()?.toString()) return; // selecting text is not asking to type
      const input = pane.querySelector("textarea");
      if (!input) return;
      // Already there, so there is nothing to put back — and calling focus() anyway would collapse
      // whatever is selected inside it. A drag that starts in the composer and ends outside it lands
      // here, and losing the selection at that moment means the next Backspace deletes one character
      // instead of the words someone just swept.
      if (document.activeElement === input) return;
      if (input.selectionStart !== input.selectionEnd) return;
      input.focus();
    };
    pane.addEventListener("mouseup", onPointerUp);
    pane.addEventListener("input", onInput);
    pane.addEventListener("keydown", onKeyDown, true); // capture: ahead of the composer's own Enter
    return () => {
      pane.removeEventListener("mouseup", onPointerUp);
      pane.removeEventListener("input", onInput);
      pane.removeEventListener("keydown", onKeyDown, true);
    };
  }, [status]);

  // Before the first turn the CLI has said nothing about its model (see modelLineOf), but the model
  // list it answered at the handshake names the account's default.
  const defaultModelFallback = pendingModelLabelOf(models, configuredModel);
  const modelLine = modelLineOf(
    modelInfo,
    (model, effort) => t("conversation.model.line", { model, effort }),
    defaultModelFallback
  );

  /** A change is on its way and the readout has not caught up — the button says so, because driving a
   *  CLI and reading it back takes long enough that a silent button looks like a missed press. */
  const [modelBusy, setModelBusy] = useState(false);

  // Whatever the change was, the readout moving is what it was waiting for.
  useEffect(() => setModelBusy(false), [modelLine]);

  // ...and it never waits forever: a CLI can refuse a switch on a screen this pane cannot see.
  useEffect(() => {
    if (!modelBusy) return;
    const timer = setTimeout(() => setModelBusy(false), MODEL_BUSY_MAX_MS);
    return () => clearTimeout(timer);
  }, [modelBusy]);

  // ...and put back when it comes back. The composer belongs to the Thread and appears a moment
  // after this pane does, so this waits for it rather than assuming it. `insertText` rather than a
  // direct assignment for the same reason the completion menu uses it: the composer is a controlled
  // input, and only a real edit reaches the store behind it.
  useEffect(() => {
    const text = draftOf(sessionId);
    if (text === "") return;
    let tries = 0;
    const timer = setInterval(() => {
      const input = paneRef.current?.querySelector("textarea");
      if (input) {
        clearInterval(timer);
        // Only into a composer nobody has touched: someone who started typing in the moment this
        // took must not have a sentence from before shoved in front of theirs.
        if (input.value === "") {
          input.focus();
          document.execCommand("insertText", false, text);
        }
        return;
      }
      if (++tries >= DRAFT_RESTORE_TRIES) clearInterval(timer);
    }, DRAFT_RESTORE_MS);
    return () => clearInterval(timer);
  }, [sessionId]);

  // What this session's CLI offers. Asked once when the pane opens rather than watched: the answer
  // depends on the account's subscription and its organisation's policy, neither of which changes
  // while someone is looking at a menu, and main keeps it cached per account for the app's life.
  useEffect(() => {
    let current = true;
    setModels([]);
    setConfiguredModel(null);
    // Asked beside the list because it is the other half of the same question — which model is this
    // session on — and the list alone cannot answer it. Its own failure is silent for the same reason
    // the list's is: the composer falls back to naming the list's default, which is what it did before
    // this existed.
    void window.api.chat
      .configuredModel(sessionId)
      .then((model) => {
        if (current) setConfiguredModel(model);
      })
      .catch(() => {});
    // The session's own adapter has the app-server's answer for this thread; the `conversation.models`
    // route reads an account's CLI and is not the same question.
    void window.api.chat
      .listModels(sessionId)
      .then((list) => {
        if (current) setModels(list);
      })
      .catch(() => {
        // The menu offers no models; the CLI's own screen still does.
      });
    return () => {
      current = false;
    };
  }, [sessionId]);

  /** Whether this session is in plan mode right now. */
  const planMode = chat === null ? false : chat.model.planMode;

  const modelSlot = useMemo<ModelControlProps>(
    () => ({
            // The menu asks the manager outright: no command is typed anywhere, no picker is walked,
            // and the answer comes back as a `model` event — which is why nothing here has to say it
            // is busy. Nothing is left over for `onChangeEffort` either: the levels this can set are
            // the whole of what there is, and there is no screen to send anyone to for the rest — so
            // the row is not offered at all (ModelControl.tsx).
            line: modelLine,
            cli: modelInfo.cli,
            choices: modelChoicesOf(models),
            onPickModel: (key) => sayIfFailed(window.api.chat.setModel(sessionId, key, modelInfo.effort)),
            // Claude's chat protocol has no effort channel at all — its `set_model` control request
            // carries only the model (claudeAdapter.ts's doSetModel) — so effortChoicesOf's rows
            // (its models still report levels; only codex's own picker gets filtered) would offer a
            // control that does nothing. Codex keeps the rows the terminal picker offers.
            effortChoices: modelInfo.cli === "claude" ? [] : effortChoicesOf(models, modelInfo.model, "codex"),
            onPickEffort: (level) => {
              // setModel takes the pair, and an effort on its own is not a pair: the model it belongs
              // to is whatever this thread is on, or the default the list marks when it has not said
              // yet. With neither there is nothing honest to send.
              const model = modelInfo.model ?? models.find((m) => m.isDefault)?.id ?? "";
              if (model === "") return;
              sayIfFailed(window.api.chat.setModel(sessionId, model, level));
            },
            busy: false,
            planMode,
            onTogglePlan: () => sayIfFailed(window.api.chat.setPlanMode(sessionId, !planMode))
          }),
    [planMode, modelLine, modelInfo.model, modelInfo.effort, modelInfo.cli, models, sessionId]
  );

  // An answer that is actually being waited on outranks everything; after that, a list being typed
  // into outranks a note about a command already sent.
  // Which of the two the prompt branch takes is shouldShowPrompt's rule, above.
  // A parsed question outranks the banner: it is the same waiting decision, drawn from the model's own
  // call rather than from the screen.
  /** A turn this pane sent is still unanswered. Drives the notice and, through `isRunning`, what the
   *  composer's own button is offering to do. */
  /** Whether anything is still in flight. The manager says it itself: it reports `working` for as
   *  long as a turn is running. */
  const cliBusy = chatStatus === "working";
  const awaitingReply = isAwaitingReply(turns, pending.length, cliBusy);
  isRunningRef.current = awaitingReply;
  /** The mark at the end of the output. Broader than `awaitingReply` on purpose — see isWorkingNow's
   *  own doc — because that one carries the composer's stop button and must not widen with it.
   *
   *  Memoised into one object because it is a context value the Thread's slot reads: a fresh object
   *  every render would re-render that slot on every keystroke in the composer beside it. */
  const runningSlot = useMemo(
    () => ({
      show: isWorkingNow(pending.length, cliBusy),
      working: chatStatus === "working",
      // Through the ref, so the memo does not rebuild — and so the button presses the very same stop
      // Escape does, rather than a second path that could drift from it.
      onStop: () => void interruptRef.current()
    }),
    [pending.length, cliBusy, chatStatus]
  );
  /** The `@` menu. */
  const completionMenu: ReactNode = (
    <CompletionMenu
      rows={rows}
      active={Math.min(slashActive, Math.max(rows.length - 1, 0))}
      onPick={takeRow}
      onHover={setSlashActive}
    />
  );
  /** What the banner slot is for, in the order paneTransport.ts sets out. */
  const chatBanner = chatBannerFor(chat);
  const banner: ReactNode = exited ? (
    <ExitedNotice onGoTerminal={null} />
  ) : chatBanner.kind === "request" ? (
    // Keyed on the request so a new one gets a new card: the old one's `busy`/`submitting` state
    // would otherwise survive into it, and the person would meet a card whose buttons are already
    // disabled by an answer they gave to something else.
    <ChatRequestCard
      key={chatBanner.request.id}
      sessionId={sessionId}
      request={chatBanner.request}
      provider={chat === null ? "codex" : chat.provider}
    />
  ) : chatBanner.kind === "error" ? (
    <ChatNotice text={t("chat.notice.error", { message: chatBanner.message })} />
  ) : chatBanner.kind === "checking" ? (
    <ChatNotice text={t("chat.notice.checking")} />
  ) : chatBanner.kind === "endsWithApp" ? (
    <ChatNotice text={t("chat.notice.endsWithApp")} />
  ) : slashOpen ? (
    completionMenu
  ) : null;

  const components = useMemo<ThreadComponents>(
    () => ({
      Welcome,
      ToolFallback: ToolRow,
      ToolGroup: ToolRowGroup,
      Banner: ConversationBannerSlot,
      Running: ConversationRunningSlot,
      ComposerExtras: ComposerModelSlot,
    }),
    [Welcome]
  );

  // Built unconditionally, ahead of the status branches below — the messages a still-loading or
  // unavailable session has are simply empty, and a hook cannot itself live behind an early return.
  const runtime = useExternalStoreRuntime({
    messages,
    // Required even though `messages` are already ThreadMessageLike: without it the runtime reads
    // `metadata` off a raw message and throws on the first render. Measured, not folklore.
    convertMessage: (m: ThreadMessageLike) => m,
    // Shut while a request is up — it is answered on the card above, not by typing — and shut until
    // the session's state has arrived at all (composerLockedFor, paneTransport.ts).
    isDisabled: exited || composerLockedFor({ kind: "chat" }, chat, false),
    // `isRunning` with a real `onCancel` behind it. The note that used to sit here said there was no
    // cancel path to give this adapter and so no honest way to set the flag; there is one now — the
    // CLI stops on Escape, which is how a person stops it in the terminal — and with it the composer's
    // own send button turns into the stop button while a turn is in flight, rather than a second
    // button somewhere else meaning the same thing.
    isRunning: awaitingReply,
    onCancel: interrupt,
    onNew,
  });

  if (status === "loading") {
    // Nothing to draw yet. Showing "unavailable" here would flash wrong for the ordinary case (a
    // session that does have a transcript) while `open` is still in flight.
    return <div data-slot="conversation-pane-loading" className="h-full" />;
  }

  // The banners are absolutely positioned, which over a terminal costs nothing — they float above
  // scrollback. Here they would sit on top of the first message, so the strip gets a box of its own
  // height at the head of the flex column and the thread starts below it. Zero, and no box at all, when
  // nothing is showing.
  const bannerStripHeight = stateBannerHeight(rollState, schedState);


  return (
    <div
      ref={paneRef}
      data-slot="conversation-pane"
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;
        e.preventDefault();
        onComposerFiles(files);
      }}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files);
        if (files.length === 0) return; // ordinary text goes through untouched
        e.preventDefault();
        onComposerFiles(files);
      }}
    >
      {bannerStripHeight > 0 && (
        <div className="relative shrink-0" style={{ height: bannerStripHeight }}>
          <SessionStateBanners sessionId={sessionId} rollState={rollState} schedState={schedState} />
        </div>
      )}
      {/* Only while a window is on its way. There is nothing to press any more, and a bar that sat
          there whenever earlier turns existed would be a button that has stopped being one. */}
      {loadingMore && (
        <div className="border-border/60 text-muted-foreground flex items-center justify-center gap-1.5 border-b py-1.5 text-xs">
          <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
          {t("conversation.loadingEarlier")}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <BannerSlotContext.Provider value={banner}>
          <RunningSlotContext.Provider value={runningSlot}>
          <ModelSlotContext.Provider value={modelSlot}>
          <AssistantRuntimeProvider runtime={runtime}>
              <MemoThread
              components={components}
              composerPlaceholder={t("conversation.composer.placeholder")}
            />
          </AssistantRuntimeProvider>
          </ModelSlotContext.Provider>
          </RunningSlotContext.Provider>
        </BannerSlotContext.Provider>
      </div>
    </div>
  );
}
