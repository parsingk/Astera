import type { Attention } from '../types'
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
 *  text, or an assistant frame's error. Consumed by rolling and Slack; the pane draws none of it, so
 *  ChatState carries no field for it. */
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
