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

export interface ChatModel {
  model: string | null
  effort: string | null
  planMode: boolean
}

export interface ChatState {
  status: ChatStatus
  request: ChatRequest | null
  model: ChatModel
  /** The last turn's failure, cleared by the next turn. */
  error: string | null
  /** Whether the process survives the app quitting (Host-owned) — the fallback's tab says it does not. */
  outlivesApp: boolean
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
  | { type: 'exit'; code: number }

export interface ChatAdapter {
  start(a: { cwd: string; resumeThreadId?: string; bypass: boolean }): Promise<void>
  send(text: string): Promise<void>
  interrupt(): Promise<void>
  answer(requestId: string, answer: ChatAnswer): Promise<void>
  setModel(model: string, effort: string | null): Promise<void>
  setPlanMode(on: boolean): Promise<void>
  listModels(): Promise<ModelDescriptor[]>
  state(): ChatState
  on(fn: (e: ChatEvent) => void): () => void
  kill(): void
}
