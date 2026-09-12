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
import { ChevronUpIcon } from "lucide-react";
import { Thread, type ThreadComponents } from "../assistant-ui/elements/thread.aui";

/** The composer belongs to this subtree, and a controlled input that re-renders while a character is
 *  on its way in can be handed back the value it had a moment ago — which is a keystroke lost. The
 *  menu below changes on every key, so the menu must not be able to re-render this: its rows travel
 *  by context to a slot inside, and everything else this takes is stable. */
const MemoThread = memo(Thread);
import { Button } from "../ui/button";
import { ToolRow, ToolRowGroup } from "./ToolRow";
import {
  PendingBanner,
  QueuedNotice,
  RunningNotice,
  SlashCommandNotice
} from "./PendingBanner";
import { ModelControl, type ModelControlProps } from "./ModelControl";
import {
  CODEX_EFFORT_ROWS,
  effortChoicesOf,
  modelChoicesOf
} from "../../../../core/models/cliModels";
import type { ModelDescriptor } from "../../../../core/models/types";
import {
  codexDigitFor,
  codexPickerStep,
  codexStatusModel
} from "../../../../core/models/codexPicker";
import { CompletionMenu, type CompletionRow } from "./CompletionMenu";
import {
  filterSlashCommands,
  type SlashCommand
} from "../../../../core/commands/slashCommands";
import { fileTokenAt } from "../../../../core/files/fileMatch";
import { draftOf, forgetDraft, keepDraft } from "./drafts";
import { promptLinesOf } from "../../../../core/history/promptLines";
import { queuedMessagesOf } from "../../../../core/history/queuedMessages";
import {
  isAwaitingReply,
  sendPending,
  unsettledSends,
  type PendingSend
} from "../../../../core/history/pendingSends";
import {
  promptChoicesOf,
  stepToward,
  type PromptChoice
} from "../../../../core/history/promptChoices";
import * as sessionBus from "../../lib/sessionBus";
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

/**
 * One reading of the model layered onto what is already known.
 *
 * A null model is not "no model" — it is the CLI not having said. codex says it a turn at a time, so
 * a session that has not answered anything reports nulls while its own screen is showing the model
 * plainly, and the screen is read separately (codexStatusModel). Letting the silence through would
 * erase that reading every time the transcript ticks, which is exactly what it did.
 *
 * A reading for a different CLI replaces everything: that is a different session's answer arriving,
 * not a quieter one.
 */
export function keepWhatIsKnown<T extends { model: string | null; effort: string | null; cli: unknown }>(
  prev: T,
  next: T
): T {
  if (next.cli !== prev.cli) return next
  return {
    ...next,
    model: next.model ?? prev.model,
    effort: next.effort ?? prev.effort
  };
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

/** How much of the CLI's screen the waiting banner quotes, and how often it re-reads it. A prompt is
 *  a handful of lines, and it moves while it is up — an arrow shifts, a second question follows.
 *  Sixteen because that is what the longest real prompt measured needs: Claude Code's trust prompt for
 *  a new folder runs fifteen lines from its rule down to `Enter to confirm`. */
const PROMPT_LINES_MAX = 16
const PROMPT_POLL_MS = 500

/** How an unnumbered choice is answered: one arrow key, then a fresh look at the screen, and never
 *  more than this many of them before giving up. The gap is what lets the CLI redraw before the next
 *  look — below it the walk reads its own stale screen and takes a second step it did not need. The
 *  cap ends a walk that is not converging (a list longer than it, a highlight that will not move)
 *  without ever pressing return on a row nobody asked for. */
const ARROW_STEP_MS = 120
const ARROW_STEPS_MAX = 12

/** How long a slash command is given to show up in the conversation before the pane says where it
 *  went. A command that becomes a prompt — every skill command — writes its user turn as soon as the
 *  CLI takes it, and main notices within its own second; one that opens the CLI's own screen never
 *  writes anything at all. So silence for this long is the evidence, and nothing needs to know in
 *  advance which kind a command was. */
const SLASH_SILENCE_MS = 4_000

/** How long to wait for one of codex's two picker screens to be the one on screen. Generous, because
 *  the cost of giving up early is only that the person finishes on the terminal, while the cost of
 *  pressing into a screen that has not arrived is a keystroke landing somewhere nobody chose. */
const CODEX_STEP_WAIT_MS = 4_000
/** How long between looks while stepping through codex's picker. One buffer read and one match, so
 *  it can be this short — and it is most of what a person waits through, since every key in that walk
 *  waits for its screen. */
const CODEX_STEP_POLL_MS = 120

/** How long after a session stops producing output its status bar is read. Not a polling interval —
 *  the read is triggered by the output itself — but a settle: a TUI redraws in several chunks, and
 *  reading between two of them can catch the bar half-rewritten. Short enough to be imperceptible. */
const MODEL_SETTLE_MS = 60

/** A bar that is already drawn produces no output, so nothing would trigger a first read if this pane
 *  opened before the terminal it reads from had registered its reader. These are that first read's
 *  retries — they stop the moment one succeeds, and never run again. */
const MODEL_OPENING_MS = 200
const MODEL_OPENING_TRIES = 10

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

/** When to look again for a model the CLI was asked to switch to, in order. Several tries rather than
 *  one long wait: the CLI rewrites its statusline as it goes, and how long that takes is not something
 *  to guess at once — the answer usually arrives inside the first step, and stopping the moment it
 *  does is what keeps the button from sitting there after the change already happened. */
const MODEL_REREAD_STEPS_MS = [250, 350, 500, 900, 1_500];

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

function ComposerModelSlot(): ReactNode {
  const props = useContext(ModelSlotContext);
  // Drawn as soon as the CLI is known, which is from the session's account rather than from anything
  // it has said. What it is *set to* can genuinely be unknown for a while — codex reports its model a
  // turn at a time, so a session that has not answered anything yet has none to report — and that is
  // no reason to withhold the menu: the choices are the CLI's own either way, and the readout says it
  // does not know yet. Nothing is drawn only when the account is gone and neither CLI can be told
  // from the other, because the menus are not interchangeable.
  if (props === null || (props.cli !== 'claude' && props.cli !== 'codex')) return null;
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
  /** The question the CLI is showing, while it is showing one. */
  const [promptLines, setPromptLines] = useState<readonly string[]>([]);
  /** A walk across an unnumbered list is in flight. A ref as well as the state below it: the walk
   *  reads this between its own awaits, where a state value would still be the one it started with. */
  const answeringRef = useRef(false);
  /** What this session's CLI says it can run. Asked once per session — see conversation.models. */
  const [models, setModels] = useState<readonly ModelDescriptor[]>([]);
  const [modelInfo, setModelInfo] = useState<{
    model: string | null
    effort: string | null
    cli: 'claude' | 'codex' | null
  }>({ model: null, effort: null, cli: null });

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
    setAttention("idle");
    setSlashSent(false);
    setModelInfo({ model: null, effort: null, cli: null });
    setComposerText("");
    composerValueRef.current = null;
    setComposerCaret(0);
    setPromptLines([]);
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
          if (isCurrent()) setModelInfo((prev) => keepWhatIsKnown(prev, info));
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
        // Something came back, so the command landed in the conversation after all and there is
        // nothing to explain.
        if (slashSilenceRef.current !== null) clearTimeout(slashSilenceRef.current);
        slashSilenceRef.current = null;
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
      // Whatever is in the composer goes with the session, not with the pane. This runs on a
      // sessionId change and on unmount, which between them are every way a composer disappears.
      if (composerValueRef.current !== null) keepDraft(sessionId, composerValueRef.current);
      generationRef.current += 1;
      mountedForRef.current = null;
      if (slashSilenceRef.current !== null) clearTimeout(slashSilenceRef.current);
      slashSilenceRef.current = null;
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

  const onNew = useCallback(
    async (message: AppendMessage) => {
      // The pty is the only channel there is — a person typing here and a person typing in the
      // terminal are doing the same thing. The typed turn is never pushed into `messages` locally:
      // it comes back through the transcript like every other turn, and adding it here would show
      // it twice.
      const text = composerTextOf(message.content);
      // Shown straight away. Without this the message is nowhere until the CLI writes it down — a
      // moment for Claude, not until the turn produces something for codex — and the only honest
      // reading of that gap is that the send did not work.
      setPending((prev) => sendPending(prev, turns, text, crypto.randomUUID(), Date.now()));
      forgetDraft(sessionId); // it was sent; there is nothing left to put back
      composerValueRef.current = null;
      if (slashSilenceRef.current !== null) clearTimeout(slashSilenceRef.current);
      slashSilenceRef.current = null;
      setSlashSent(false);
      if (isSlashCommand(text)) {
        slashSilenceRef.current = setTimeout(() => setSlashSent(true), SLASH_SILENCE_MS);
      }
      const [paste, submit] = ptyWritesFor(text);
      window.api.sessions.write(sessionId, paste);
      setTimeout(() => window.api.sessions.write(sessionId, submit), SUBMIT_GAP_MS);
    },
    [sessionId, turns]
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

  // What the CLI is waiting on, read from the terminal's own buffer.
  //
  // The buffer, not the rendered rows: while the conversation is the one showing, that terminal is
  // hidden and xterm stops *painting* it, so its DOM holds whatever was on screen when it was last
  // visible. Quoting that put a question from minutes ago next to an invitation to answer — worse
  // than showing nothing. `write` keeps the buffer current regardless of painting, and sessionBus
  // hands out a reader for exactly that (registered by TerminalView, which already needed it).
  //
  // Polled, because a screen is not an event: the highlighted choice moves, a second question
  // follows the first. Only while something is actually being asked.
  useEffect(() => {
    if (attention !== "waiting") {
      setPromptLines([]);
      return;
    }
    const read = (): void => {
      const screen = sessionBus.screenOf(sessionId);
      if (screen === null) return; // no terminal registered — cannot tell, so leave what is there
      setPromptLines(promptLinesOf(screen.split("\n"), PROMPT_LINES_MAX));
    };
    read();
    const timer = setInterval(read, PROMPT_POLL_MS);
    return () => clearInterval(timer);
  }, [attention, sessionId]);

  // The rows of that same quote, as something to press. They come out of the quote rather than
  // alongside it, so what the buttons say and what the banner shows can never be two different
  // readings of the screen.
  const choices = useMemo(() => promptChoicesOf(promptLines), [promptLines]);
  const [answering, setAnswering] = useState(false);

  /**
   * Answers one of those rows on the CLI's own screen.
   *
   * A numbered row is sent as its number: that is an answer the CLI takes whole, and it does not
   * depend on where the highlight happens to be.
   *
   * An unnumbered one has to be walked to, and the walk asks the screen again before every key it
   * sends (stepToward in core/history/promptChoices.ts explains why in full). The short of it: the
   * last key of a walk is a return, and a return pressed against a screen that moved confirms
   * something nobody chose, with no way back. Re-reading costs a buffer read per step.
   *
   * Nothing is pressed when the row is no longer there — the prompt was answered on the terminal, or
   * a different one replaced it. The button goes quiet for the length of the walk so a second press
   * cannot interleave its own arrows with this one's.
   */
  const answerChoice = useCallback(
    async (choice: PromptChoice): Promise<void> => {
      if (answeringRef.current) return;
      answeringRef.current = true;
      setAnswering(true);
      try {
        if (choice.number !== null) {
          window.api.sessions.write(sessionId, String(choice.number));
          return;
        }
        for (let step = 0; step < ARROW_STEPS_MAX; step++) {
          const screen = sessionBus.screenOf(sessionId);
          if (screen === null) return; // no terminal registered — nothing to read, so nothing to press
          const now = promptChoicesOf(promptLinesOf(screen.split("\n"), PROMPT_LINES_MAX));
          const key = stepToward(now, choice.label);
          if (key === null) return; // the row is gone: the prompt was answered or replaced
          if (key === "enter") {
            window.api.sessions.write(sessionId, "\r");
            return;
          }
          window.api.sessions.write(sessionId, key === "down" ? "\u001b[B" : "\u001b[A");
          await new Promise((resolve) => setTimeout(resolve, ARROW_STEP_MS));
        }
      } finally {
        answeringRef.current = false;
        setAnswering(false);
      }
    },
    [sessionId]
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

  // What the CLI is holding until the turn it is on finishes. Its queue, not ours — read off its
  // screen the same way and for the same reason as everything else here, on the output that changes
  // it rather than on a clock.
  const [queued, setQueued] = useState<readonly string[]>([]);
  useEffect(() => {
    const read = (): void => {
      const screen = sessionBus.screenOf(sessionId);
      if (screen === null) return;
      const now = queuedMessagesOf(screen.split("\n"));
      setQueued((prev) =>
        prev.length === now.length && prev.every((text, i) => text === now[i]) ? prev : now
      );
    };
    read();
    let settle: ReturnType<typeof setTimeout> | undefined;
    const stop = sessionBus.observe(sessionId, () => {
      clearTimeout(settle);
      settle = setTimeout(read, MODEL_SETTLE_MS);
    });
    return () => {
      clearTimeout(settle);
      stop();
    };
  }, [sessionId]);

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

  // What codex is running, read off the bar it keeps at the bottom of its own screen.
  //
  // The app's other source is the rollout, and it records this a turn at a time: a session that has
  // not answered anything reports no model at all, and one whose model was just changed from this
  // very menu goes on reporting the old one until the next turn. Neither is what the person who just
  // changed it is looking at. The screen is, and the buffer behind it keeps taking writes whether or
  // not this view is the one showing (the same reading the waiting banner is built on).
  //
  // Read when the screen changes, not on a clock. The output that redraws that bar already arrives
  // here — sessionBus carries it to the terminal — so this listens in on it. A timer would be a
  // choice between a readout that lags and work done every tick forever; this is neither, and it
  // answers a change made on the terminal just as promptly as one made from this menu.
  //
  // Claude needs none of this: it writes a statusline the app already receives.
  useEffect(() => {
    if (modelInfo.cli !== "codex") return;
    const read = (): boolean => {
      const screen = sessionBus.screenOf(sessionId);
      if (screen === null) return false; // no terminal registered for this session yet
      const now = codexStatusModel(screen.split("\n"));
      if (now === null) return false; // a picker is up over the bar, or codex is still starting
      setModelInfo((prev) =>
        prev.model === now.model && prev.effort === now.effort ? prev : { ...prev, ...now }
      );
      return true;
    };
    // The bar is already there — this pane may have opened long after it was drawn, and a drawn bar
    // sends nothing that would wake the listener below.
    let left = MODEL_OPENING_TRIES;
    const opening = setInterval(() => {
      if (read() || --left <= 0) clearInterval(opening);
    }, MODEL_OPENING_MS);
    if (read()) clearInterval(opening);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const stop = sessionBus.observe(sessionId, () => {
      clearTimeout(settle);
      settle = setTimeout(read, MODEL_SETTLE_MS);
    });
    return () => {
      clearInterval(opening);
      clearTimeout(settle);
      stop();
    };
  }, [modelInfo.cli, sessionId]);

  // What this session's CLI offers. Asked once when the pane opens rather than watched: the answer
  // depends on the account's subscription and its organisation's policy, neither of which changes
  // while someone is looking at a menu, and main keeps it cached per account for the app's life.
  useEffect(() => {
    let current = true;
    setModels([]);
    void window.api.conversation
      .models(sessionId)
      .then((result) => {
        if (current) setModels(result.models);
      })
      .catch(() => {
        // The menu offers no models; the CLI's own screen still does.
      });
    return () => {
      current = false;
    };
  }, [sessionId]);

  /**
   * Read the model back until `moved` says it has, and answer whether it did.
   *
   * Each read is applied as it comes, so the readout follows the first one that carries the change
   * rather than the last one in the ladder. False means every look still showed the old value, which
   * is the only evidence available that a switch is waiting on the CLI's own screen instead.
   */
  const rereadModelUntil = useCallback(
    async (moved: (info: { model: string | null; effort: string | null }) => boolean) => {
      for (const delay of MODEL_REREAD_STEPS_MS) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        let info: Awaited<ReturnType<typeof window.api.conversation.model>>;
        try {
          info = await window.api.conversation.model(sessionId);
        } catch {
          continue; // the readout keeps what it had; nothing here is worth interrupting a person for
        }
        setModelInfo((prev) => keepWhatIsKnown(prev, info));
        if (moved(info)) return true;
      }
      return false;
    },
    [sessionId]
  );

  /** Wait until the screen codex is showing is the one named, and answer with its lines. Null when it
   *  never arrives — the caller's cue to stop pressing keys and hand over to the terminal. */
  const waitForCodexStep = useCallback(
    async (which: "model" | "effort"): Promise<string[] | null> => {
      const deadline = Date.now() + CODEX_STEP_WAIT_MS;
      for (;;) {
        const screen = sessionBus.screenOf(sessionId);
        if (screen !== null) {
          const rows = screen.split("\n");
          if (codexPickerStep(rows) === which) return rows;
        }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, CODEX_STEP_POLL_MS));
      }
    },
    [sessionId]
  );

  /**
   * Set codex's reasoning level from here.
   *
   * codex has no `/effort`. `/model` asks two questions on one command — the model, then the
   * reasoning level — so reaching the second means answering the first, and the answer that changes
   * nothing is Enter on the model it is already on.
   *
   * Every key waits for the screen it is meant for and is chosen from that screen's own rows. A
   * counted sequence would be three guesses about a terminal this cannot see, and the key it would
   * guess wrong about is the one that confirms. When a screen does not arrive, or the level is not
   * among its rows, nothing further is pressed and the question is left up for a person.
   */
  const pickCodexEffort = useCallback(
    async (level: string): Promise<void> => {
      const row = CODEX_EFFORT_ROWS[level];
      setModelBusy(true);
      if (row === undefined) {
        // `max` and `ultra` sit behind codex's own `More reasoning…` row, a screen further in.
        setModelBusy(false);
        sendCommand("/model");
        goTerminal();
        return;
      }
      sendCommand("/model");
      if ((await waitForCodexStep("model")) === null) {
        setModelBusy(false);
        goTerminal();
        return;
      }
      window.api.sessions.write(sessionId, "\r"); // keep the model it is on
      const rows = await waitForCodexStep("effort");
      if (rows === null) {
        setModelBusy(false);
        goTerminal();
        return;
      }
      const digit = codexDigitFor(rows, row);
      if (digit === null) {
        setModelBusy(false);
        goTerminal(); // codex renamed its rows; its own screen is still up and readable
        return;
      }
      // The readout follows from codex's own status bar (the poll above), not from a re-read of the
      // rollout — that is a turn behind and would put the old level back.
      window.api.sessions.write(sessionId, digit); // a digit selects and confirms in one keystroke
    },
    [sendCommand, waitForCodexStep, goTerminal, sessionId]
  );

  /**
   * Switch codex's model from here.
   *
   * Its picker is answered by position, and the row a name sits at is codex's to change — so the
   * digit is read off the screen that is up rather than counted from a list this app keeps
   * (codexDigitFor). A name that is no longer listed presses nothing.
   *
   * codex asks for the reasoning level straight after, and Enter there keeps the level it is already
   * pointing at: the person asked for a model, not a level, so that is the answer that changes only
   * what was asked for.
   */
  const pickCodexModel = useCallback(
    async (id: string): Promise<void> => {
      setModelBusy(true);
      sendCommand("/model");
      const rows = await waitForCodexStep("model");
      if (rows === null) {
        setModelBusy(false);
        goTerminal();
        return;
      }
      const digit = codexDigitFor(rows, id);
      if (digit === null) {
        setModelBusy(false);
        goTerminal();
        return;
      }
      window.api.sessions.write(sessionId, digit);
      if ((await waitForCodexStep("effort")) === null) {
        setModelBusy(false);
        goTerminal();
        return;
      }
      window.api.sessions.write(sessionId, "\r"); // keep the level it is pointing at
    },
    [sendCommand, waitForCodexStep, goTerminal, sessionId]
  );

  const modelSlot = useMemo<ModelControlProps>(
    () => ({
      line: modelLine,
      onPickModel: (key) => {
        if (modelInfo.cli === 'codex') {
          void pickCodexModel(key);
          return;
        }
        const was = modelInfo.model;
        setModelBusy(true);
        sendCommand(`/model ${key}`);
        // Switching to another family asks first, because the conversation is cached for the model it
        // is on — and it asks on the CLI's own screen, which is not this one. Nothing here can tell in
        // advance which switches ask, so the evidence is that the model never moved: either something
        // is waiting over there, or it was already this model and the notice costs a glance. Cleared
        // when it did move: a switch that went through has nothing to explain.
        void rereadModelUntil((info) => info.model !== was).then((moved) => {
          setModelBusy(false);
          setSlashSent(!moved);
        });
      },
      onPickEffort: (key) => {
        if (modelInfo.cli === 'codex') {
          void pickCodexEffort(key);
          return;
        }
        // Claude's own screen is a slider, but the command takes the name outright, so there is
        // nothing to drive (measured 2026-09-12: `/effort high` answered "Set effort level to high").
        // It is saved as the default for new sessions, which is what that screen's Enter does too.
        const was = modelInfo.effort;
        setModelBusy(true);
        sendCommand(`/effort ${key}`);
        void rereadModelUntil((info) => info.effort !== was).then(() => setModelBusy(false));
      },
      onChangeEffort: () => {
        // What the rows above do not cover: Claude's `s` (this session only) and codex's Max and
        // Ultra, both of which live one screen further in. Open the CLI's own screen for those.
        sendCommand(modelInfo.cli === 'codex' ? "/model" : "/effort");
        goTerminal();
      },
      busy: modelBusy,
      effortLabel: t("conversation.model.effortMore"),
      cli: modelInfo.cli,
      effortChoices: effortChoicesOf(models, modelInfo.model, modelInfo.cli),
      choices: modelChoicesOf(models)
    }),
    [
      modelLine,
      modelInfo.model,
      modelInfo.cli,
      modelBusy,
      models,
      sendCommand,
      goTerminal,
      pickCodexModel,
      pickCodexEffort,
      rereadModelUntil,
      sessionId,
      t
    ]
  );

  // An answer that is actually being waited on outranks everything; after that, a list being typed
  // into outranks a note about a command already sent.
  const banner: ReactNode =
    attention === "waiting" ? (
      <PendingBanner
        onGoTerminal={goTerminal}
        lines={promptLines}
        choices={choices}
        onChoose={(choice) => void answerChoice(choice)}
        answering={answering}
      />
    ) : slashOpen ? (
      <CompletionMenu
        rows={rows}
        active={Math.min(slashActive, Math.max(rows.length - 1, 0))}
        onPick={takeRow}
        onHover={setSlashActive}
      />
    ) : queued.length > 0 ? (
      <QueuedNotice messages={queued} onGoTerminal={goTerminal} />
    ) : isAwaitingReply(turns, pending.length) ? (
      <RunningNotice working={attention === "working"} />
    ) : slashSent ? (
      <SlashCommandNotice onGoTerminal={goTerminal} />
    ) : null;

  const components = useMemo<ThreadComponents>(
    () => ({
      Welcome,
      ToolFallback: ToolRow,
      ToolGroup: ToolRowGroup,
      Banner: ConversationBannerSlot,
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
    // `isDisabled` does reach the composer's actual <textarea> — assistant-ui's
    // useComposerInputDisabled (useComposerInputState.js) ORs it with a `disabled` prop, and
    // ComposerInput.js applies the result — so this is the real lock, not a stand-in for one.
    // Never disabled. The composer writes to the very pty the CLI's prompt is on, so a person can
    // answer it from here — see `locked`'s removal below for the whole reasoning.
    isDisabled: false,
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


  return (
    <div
      ref={paneRef}
      data-slot="conversation-pane"
      className="flex h-full min-h-0 flex-col"
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
              <MemoThread
              components={components}
              composerPlaceholder={t("conversation.composer.placeholder")}
            />
          </AssistantRuntimeProvider>
          </ModelSlotContext.Provider>
        </BannerSlotContext.Provider>
      </div>
    </div>
  );
}
