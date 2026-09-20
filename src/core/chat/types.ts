import type { Attention, RateLimitWindow } from '../types'
import type { AskForm, Answer } from '../prompts/askUserQuestion'
import type { ToolRequestSummary } from '../prompts/toolRequest'
import type { ModelDescriptor } from '../models/types'
import type { Provider } from '../providers/meta'

/** The same three words the attention state uses, on purpose: a chat session's status IS its attention. */
export type ChatStatus = Attention
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline'

export type ChatRequest =
  | { id: string; kind: 'approval'; about: ToolRequestSummary; decisions: ApprovalDecision[] }
  | { id: string; kind: 'question'; form: AskForm }

export type ChatAnswer =
  | { kind: 'approval'; decision: ApprovalDecision }
  | { kind: 'question'; answers: Answer[] }

/** How much the CLI may do without asking. Claude calls it a permission mode and codex a
 *  collaboration mode; the three here are the ones both the composer's control offers and this app
 *  knows how to ask for. Claude's own `bypassPermissions` is deliberately not among them — it is
 *  chosen when the session is made, and a live switch into it belongs to that decision, not to a
 *  menu beside the composer. A session already running in it reads as `default`, which is the
 *  honest neutral: picking `default` there really does step the CLI down. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

/** One row of the composer's mode menu.
 *
 *  `label` is the CLI's own word for the mode — codex answers `name` on its list — and **empty when
 *  it has none**, which is Claude's case: its set is fixed and unnamed on the wire. An empty label is
 *  the cue to use this app's translated word instead, so the button never shows `acceptEdits` to
 *  someone reading Korean. */
export interface PermissionModeChoice {
  key: PermissionMode
  label: string
}

export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'default' || v === 'acceptEdits' || v === 'plan'
}

export interface ChatModel {
  model: string | null
  effort: string | null
  permissionMode: PermissionMode
}

export interface ChatState {
  status: ChatStatus
  request: ChatRequest | null
  model: ChatModel
  /** The last turn's failure, cleared by the next turn. */
  error: string | null
  /** The exit code, once the process has gone. Null while it is alive. The pane shows it beside the
   *  exit notice — the terminal has always shown one and the chat pane never did (design D2). */
  exitCode: number | null
  /** The process's last words on stderr. `error` above is the one line a person reads; this is the
   *  whole tail, which the pane folds away. Kept apart rather than concatenated: joining them would
   *  make the screen split the string again to draw either one. */
  errorDetail: string | null
  /** Whether the process survives the app quitting (Host-owned) — the fallback's tab says it does not. */
  outlivesApp: boolean
  /** design F5: the person's confirmed toolchain-skip retry succeeded, which may have started a
   *  version other than the one the person pinned for this folder — never silent about that. Optional,
   *  not required-and-null, so the many `ChatState` literals a test builds for something else stay as
   *  they are; absent reads the same as null. Not folded into `error`: the exit banner (T4) would
   *  mistake it for the reason the session died, and this is the opposite of a failure. */
  notice?: 'bypassed' | null
  /** design F5: this death can be retried past a version manager's refusal, if the person chooses to.
   *  True only when **both** the death looked like a refusal (no protocol line, immediate — S7's own
   *  test, `looksLikeRefusal`) *and* main found positive evidence a bypassable manager is actually in
   *  the way — never a guess. The exit banner renders a button only when this is set; when the death
   *  looks like a refusal but no manager was found, F1/F2's explanation stands on its own and no button
   *  appears. Optional for the same reason `notice` above is: absent reads the same as false. */
  bypassOffer?: boolean
  /** The replay this state was rebuilt from had lost its head, so `status` is a guess until the next event. */
  truncated: boolean
  /** Which CLI this session is — set once at construction (adapterCore.ts), never patched. */
  provider: Provider
}

/** A Claude rate-limit signal, however it arrived — the dedicated event, a rejected turn's result
 *  text, or an assistant frame's error. Consumed by rolling and Slack, and by the status bar's two
 *  limit chips through `windows`; the pane itself draws none of it. */
export interface RateLimitInfo {
  /** 'allowed' | 'allowed_warning' | 'rejected' as the CLI says it; anything else is passed through for the log. */
  status: string
  /** Epoch milliseconds (the wire carries seconds); null when the CLI gave none. */
  resetsAt: number | null
  /** 0..1 as the wire carries it; null when absent. */
  utilization: number | null
  /** The wire's rateLimitType; null when absent. */
  window: string | null
  /** Where the signal came from — the event itself, a rejected turn's result text, or an assistant frame's error. */
  source: 'event' | 'result' | 'assistant'
  /** Both limit windows as the event's `unifiedWindows` gives them, already turned into percentages.
   *  `window` and `utilization` above name only the one that fired, which is a warning, not a reading:
   *  the status bar draws both chips and a signal about the weekly one says nothing about the 5-hour.
   *  null when the signal was inferred rather than received (a rejected turn, an assistant error),
   *  because those carry no figures at all. Optional so the many places that build this value for a
   *  test of something else stay as they are: every consumer treats absent and null alike. */
  windows?: { session: RateLimitWindow | null; weekly: RateLimitWindow | null } | null
}

/** What a finished turn left sitting in the context, off the CLI's own accounting for that turn.
 *  `windowByModel` holds every model the turn accounted for, the sub-agent's included: the frame does
 *  not say which one the conversation is on, and the reader of this does. */
export interface ChatContextUsage {
  usedTokens: number
  windowByModel: Record<string, number>
}

export type ChatEvent =
  | { type: 'ready'; threadId: string; rolloutPath: string | null }
  /** `truncated` rides along on the status event because the two move together: the first thing a
   *  rebuilt session hears that is definite about its turn both settles the status and ends the guess
   *  (see codexAdapter.ts). Optional so a sender that has nothing to say about it says nothing — a
   *  fold that sees it absent leaves the flag as it was. */
  | { type: 'status'; status: ChatStatus; truncated?: boolean }
  | { type: 'request'; request: ChatRequest | null }
  | { type: 'model'; model: ChatModel }
  | { type: 'error'; message: string }
  /** Claude only, for now. */
  | { type: 'rateLimit'; info: RateLimitInfo }
  /** Claude only: what the turn that just finished left in the context. A pty session reads the same
   *  figure off its statusLine; a chat session has no statusLine, so it is reported here. */
  | { type: 'usage'; context: ChatContextUsage }
  /** The process's last words ride with the code, not only in main's `ChatState` — this app folds
   *  renderer state out of events (see `foldChatEvent`), so a pane already open when the process dies
   *  hears only what this carries; a value left solely on `ChatState` never reaches it. `errorDetail`
   *  is always here, the tail or null: an absent tail is itself the fact "we do not know", which is
   *  different from `truncated` above having nothing to say. `error` is optional — present only when
   *  the tail gave a reason a person should read — so the fold can leave whatever `error` already
   *  held rather than inventing one. */
  /** `bypassOffer` mirrors `ChatState.bypassOffer` (design F5) — present and `true` only when the
   *  manager decided this exit may be retried past the toolchain manager that refused it. It has to
   *  ride the event, not just sit in `ChatState`: a pane already open when the process dies never
   *  re-reads main's state, it only ever hears this. */
  | { type: 'exit'; code: number; errorDetail: string | null; error?: string; bypassOffer?: boolean }
  /** design F5: the person's confirmed retry started the CLI. Its own event, not a value folded onto
   *  `exit` or `error` — it is not a failure, and routing it through either would have some reader
   *  mistake it for one. `key` names which notice, the same shape `chat.notice.*` i18n keys use, so a
   *  second cause (a different toolchain manager's bypass) is a second key rather than a new field. */
  | { type: 'notice'; key: 'bypassed' }

export interface ChatAdapter {
  start(a: { cwd: string; resumeThreadId?: string; bypass: boolean }): Promise<void>
  send(text: string): Promise<void>
  interrupt(): Promise<void>
  answer(requestId: string, answer: ChatAnswer): Promise<void>
  setModel(model: string, effort: string | null): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  /** The rows the composer's mode menu draws. Claude answers a fixed three without a round trip;
   *  codex answers what it listed at startup, which may be empty when that list was refused. */
  listPermissionModes(): Promise<PermissionModeChoice[]>
  listModels(): Promise<ModelDescriptor[]>
  state(): ChatState
  on(fn: (e: ChatEvent) => void): () => void
  kill(): void
}
