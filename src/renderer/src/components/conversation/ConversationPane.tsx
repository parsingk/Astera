"use client";

import {
  createContext,
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
import { ChevronUpIcon } from "lucide-react";
import { Thread, type ThreadComponents } from "../assistant-ui/elements/thread.aui";
import { Button } from "../ui/button";
import { ToolRow, ToolRowGroup } from "./ToolRow";
import { PendingBanner, SlashCommandNotice } from "./PendingBanner";
import { ModelControl, type ModelControlProps } from "./ModelControl";
import {
  CLAUDE_MODEL_CHOICES,
  CODEX_MODEL_CHOICES
} from "../../../../core/models/cliModels";
import { CompletionMenu, type CompletionRow } from "./CompletionMenu";
import {
  filterSlashCommands,
  type SlashCommand
} from "../../../../core/commands/slashCommands";
import { fileTokenAt } from "../../../../core/files/fileMatch";
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
/**
 * What the composer puts on the pty for one message: the text as a bracketed paste, then the return
 * that submits it. Two strings because they have to arrive as two chunks — see `onNew`.
 *
 * The markers are how a terminal says "this is pasted, not typed". Without them the CLI reads the
 * text key by key through its own autocomplete, so a line beginning with `/` opens its command menu
 * and the return picks whatever that menu has highlighted instead of running what was typed: sending
 * `/status` this way opened the model picker and saved a default (measured in the dev app). They also
 * keep a newline inside a message from submitting it halfway through.
 */
export function ptyWritesFor(text: string): [paste: string, submit: string] {
  return ["\u001b[200~" + text + "\u001b[201~", "\r"];
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

/**
 * Whether what a person just sent is a slash command rather than a message.
 *
 * Leading whitespace only, deliberately: `/` anywhere else is a path or a date, and a message that
 * merely mentions one is not a command. Nothing is inferred about which command it is — every one of
 * them draws on the CLI's own screen, and that is the whole point of the notice this decides.
 */
export function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/**
 * The one-line label for what the CLI is running under, or null when it has told us nothing worth
 * drawing. Effort alone is not worth a line: it means nothing without the model it belongs to.
 */
export function modelLineOf(
  info: { model: string | null; effort: string | null },
  format: (model: string, effort: string) => string
): string | null {
  if (info.model === null) return null;
  if (info.effort === null) return info.model;
  return format(info.model, info.effort);
}

/** How long after the paste the return is sent. The two have to arrive as two chunks — together they
 *  reach the CLI as one, the return is swallowed into the paste, and nothing is submitted at all —
 *  and how much separation is enough turns out to differ by CLI: Claude's took every gap tried,
 *  codex's dropped some of the short ones (measured on both, 2026-09-12). A quarter second is far
 *  above where the failures were and is nothing a person waits on, since the composer has already
 *  cleared by then. */
const SUBMIT_GAP_MS = 250

/** How long codex's `/model` takes to put its picker on screen before the chosen row can be pressed.
 *  Generous on purpose: a keystroke that arrives early lands in the composer instead, where it is one
 *  visible stray character rather than a wrong choice. */
const CODEX_PICKER_MS = 1_500

/** How long to wait before re-reading the model after asking the CLI to switch. It rewrites its
 *  statusline as it goes, but not within the same breath as the command. */
const MODEL_REREAD_MS = 1_500;

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

function ConversationBannerSlot(): ReactNode {
  return useContext(BannerSlotContext);
}

function ComposerModelSlot(): ReactNode {
  const props = useContext(ModelSlotContext);
  // Nothing known, nothing drawn. A session whose CLI has not said what it is running is either just
  // starting or is codex, which keeps no statusline at all — and the menu's model names are the
  // Claude CLI's own aliases, so offering them on a codex session would send a command it has never
  // heard of. Drawing only what has been read keeps that from being possible.
  if (props === null || props.line === null) return null;
  return <ModelControl {...props} />;
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
  // Set when a slash command is sent from here, cleared the moment anything comes back — see
  // SlashCommandNotice for what it says and why it is not the pending banner.
  const [slashSent, setSlashSent] = useState(false);
  // What `/` offers, read once when the pane opens, and what the composer holds right now. The text
  // is tracked by listening to the composer rather than asking the runtime for it: the input is
  // assistant-ui's, `input` events bubble to this pane's own root, and that is the whole of it.
  const [commands, setCommands] = useState<readonly SlashCommand[]>([]);
  const [composerText, setComposerText] = useState("");
  const [composerCaret, setComposerCaret] = useState(0);
  const [fileMatches, setFileMatches] = useState<readonly string[]>([]);
  const [slashActive, setSlashActive] = useState(0);
  const [modelInfo, setModelInfo] = useState<{
    model: string | null
    effort: string | null
    canPick: boolean
  }>({ model: null, effort: null, canPick: true });

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
    setAttention("idle");
    setSlashSent(false);
    setModelInfo({ model: null, effort: null, canPick: true });
    setComposerText("");
    setComposerCaret(0);
    setFileMatches([]);
    setSlashActive(0);
    setSlashDismissed(false);

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
    // Nothing pushes the model: it changes only when a person changes it, on the CLI's own screen.
    // Read once here and again on every turn, which is the one moment we know the CLI has just been
    // through a render and rewritten what we read this from.
    const readModel = (): void => {
      void window.api.conversation
        .model(sessionId)
        .then((info) => {
          if (isCurrent()) setModelInfo(info);
        })
        .catch(() => {});
    };
    readModel();

    void window.api.conversation
      .commands(sessionId)
      .then((list) => {
        if (isCurrent()) setCommands(list);
      })
      .catch(() => {});

    const offAppend = window.api.on("conversation:append", (e) => {
      if (!isCurrent()) return;
      if (e.sessionId === sessionId) {
        // Something came back, so the notice has said what it had to say.
        setSlashSent(false);
        readModel();
      }
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
      generationRef.current += 1;
      mountedForRef.current = null;
      offAppend();
      offAttention();
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

  const messages = useMemo(() => toThreadMessages(turns), [turns]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      // The pty is the only channel there is — a person typing here and a person typing in the
      // terminal are doing the same thing. The typed turn is never pushed into `messages` locally:
      // it comes back through the transcript like every other turn, and adding it here would show
      // it twice.
      const text = composerTextOf(message.content);
      setSlashSent(isSlashCommand(text));
      const [paste, submit] = ptyWritesFor(text);
      window.api.sessions.write(sessionId, paste);
      setTimeout(() => window.api.sessions.write(sessionId, submit), SUBMIT_GAP_MS);
    },
    [sessionId]
  );

  const Welcome = useCallback(
    (): ReactNode => (
      <div
        data-slot="conversation-pane-empty"
        className="text-muted-foreground px-4 text-center text-sm"
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
  const slashMatches = slashDismissed ? null : filterSlashCommands(commands, composerText);

  // `@` is looked for only when `/` is not answering: a line that starts a command is not also naming
  // a file, and two menus over one composer would have to fight over the same Enter.
  const fileToken =
    slashDismissed || slashMatches !== null ? null : fileTokenAt(composerText, composerCaret);
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
    slashMatches !== null
      ? slashMatches.map((c) => ({
          key: `${c.source}:${c.name}`,
          label: `/${c.name}`,
          hint: c.description,
          right: c.source
        }))
      : fileToken === null
        ? []
        : fileMatches.map((p) => ({ key: p, label: p }));
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
      // Deferred: this listener sits on the pane, which is inside React's own root, so a state
      // update made here lands in the middle of the keystroke's dispatch and can make React paint
      // before the composer's own handler has taken the character. A microtask puts it after every
      // handler for that event, which is where a bystander belongs.
      queueMicrotask(() => {
        setSlashDismissed(false);
        setComposerText(target.value);
        setComposerCaret(target.selectionStart ?? target.value.length);
        setSlashActive(0);
      });
    };
    const onKeyDown = (e: KeyboardEvent): void => {
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

  const modelLine = modelLineOf(modelInfo, (model, effort) =>
    t("conversation.model.line", { model, effort })
  );

  // The same two writes the composer makes, for a command a control sends rather than a person types.
  const sendCommand = useCallback(
    (text: string): void => {
      const [paste, submit] = ptyWritesFor(text);
      window.api.sessions.write(sessionId, paste);
      setTimeout(() => window.api.sessions.write(sessionId, submit), SUBMIT_GAP_MS);
    },
    [sessionId]
  );

  const goTerminal = useCallback((): void => {
    setSlashSent(false);
    onGoTerminal();
  }, [onGoTerminal]);

  const modelSlot = useMemo<ModelControlProps>(
    () => ({
      line: modelLine,
      onPickModel: (key) => {
        if (!modelInfo.canPick) {
          // codex takes no name: open its picker, press the row, and stop. It asks for the reasoning
          // level next, on a screen that names the model it is asking about — so the person confirms
          // what was actually chosen instead of trusting a list that may have moved under us.
          sendCommand("/model");
          setTimeout(() => window.api.sessions.write(sessionId, key), CODEX_PICKER_MS);
          goTerminal();
          return;
        }
        const was = modelInfo.model;
        sendCommand(`/model ${key}`);
        // `/model` writes a new statusline as it switches, but not instantly.
        setTimeout(() => {
          void window.api.conversation
            .model(sessionId)
            .then((info) => {
              setModelInfo(info);
              // Switching to another family asks first, because the conversation is cached for the
              // model it is on — and it asks on the CLI's own screen, which is not this one. Nothing
              // here can tell in advance which switches ask, so the evidence is that the model did
              // not move: either something is waiting over there, or it was already this model and
              // the notice costs a glance.
              // And cleared when it did move: a switch that went through has nothing to explain.
              setSlashSent(info.model === was);
            })
            .catch(() => {});
        }, MODEL_REREAD_MS);
      },
      onChangeEffort: () => {
        // Claude's `/effort` opens a slider of its own — low through ultracode — and codex's `/model`
        // opens a picker that sets both. Neither takes an argument, so there is nothing to set from
        // here: open the CLI's own screen and take the person to it rather than drive it blind.
        sendCommand(modelInfo.canPick ? "/effort" : "/model");
        goTerminal();
      },
      effortLabel: t(modelInfo.canPick ? "conversation.model.effort" : "conversation.model.change"),
      choices: modelInfo.canPick ? CLAUDE_MODEL_CHOICES : CODEX_MODEL_CHOICES
    }),
    [modelLine, modelInfo.model, modelInfo.canPick, sendCommand, goTerminal, sessionId, t]
  );

  // An answer that is actually being waited on outranks everything; after that, a list being typed
  // into outranks a note about a command already sent.
  const banner: ReactNode =
    attention === "waiting" ? (
      <PendingBanner onGoTerminal={goTerminal} />
    ) : slashOpen ? (
      <CompletionMenu
        rows={rows}
        active={Math.min(slashActive, Math.max(rows.length - 1, 0))}
        onPick={takeRow}
        onHover={setSlashActive}
      />
    ) : slashSent ? (
      <SlashCommandNotice onGoTerminal={goTerminal} />
    ) : null;

  const components = useMemo<ThreadComponents>(
    () => ({
      Welcome,
      ToolFallback: ToolRow,
      ToolGroup: ToolRowGroup,
      Banner: banner === null ? undefined : ConversationBannerSlot,
      ComposerExtras: ComposerModelSlot,
    }),
    [Welcome, banner]
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

  if (status === "loading") {
    // Nothing to draw yet. Showing "unavailable" here would flash wrong for the ordinary case (a
    // session that does have a transcript) while `open` is still in flight.
    return <div data-slot="conversation-pane-loading" className="h-full" />;
  }

  const locked = attention === "waiting";

  return (
    <div ref={paneRef} data-slot="conversation-pane" className="flex h-full min-h-0 flex-col">
      {more && (
        <div className="border-border/60 flex justify-center border-b py-1">
          <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
            <ChevronUpIcon />
            {t("conversation.loadMore")}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <BannerSlotContext.Provider value={banner}>
          <ModelSlotContext.Provider value={modelSlot}>
          <AssistantRuntimeProvider runtime={runtime}>
            <Thread components={components} composerPlaceholder={t("conversation.composer.placeholder")} />
          </AssistantRuntimeProvider>
          </ModelSlotContext.Provider>
        </BannerSlotContext.Provider>
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
