// The pure codec between Claude Code's stream-json control protocol (one JSON object per line, over
// stdio) and this app's ChatRequest / ChatAnswer / ChatEvent (core/chat/types.ts). No process, no Node
// import -- the adapter (a later task) drives a ProcLike through this codec; everything here is a total
// function from a line (or a frame already decoded from one) to a value, tested without a real CLI
// running. Measured facts encoded below (see .../slice3-records/claude-stream-measurements.md): a
// permission prompt (AskUserQuestion included) arrives as a `control_request { subtype: 'can_use_tool' }`
// routed through `--permission-prompt-tool stdio`; `system/init` carries the model and repeats every
// turn with the same `session_id` (there is no separate turn id, so `session_id` doubles as one); and
// `system/status` carries only `permissionMode` -- never enough to build a full `model` event without
// inventing `model: null`, hence the dedicated `planMode` effect (see `claudeEffectsOf` below).

import type { ChatAnswer, ApprovalDecision, RateLimitInfo, PermissionMode } from './types'
import { isPermissionMode } from './types'
import type { RateLimitWindow } from '../types'
import { parseAskUserQuestion, expectedAnswers } from '../prompts/askUserQuestion'
import { describeToolRequest } from '../prompts/toolRequest'
import type { ModelDescriptor } from '../models/types'
import { parseClaudeModels } from '../models/parse'
import type { ProtocolEffect, DecodedRequest } from './codexProtocol'
import { matchesLimitPhrase } from '../rolling/detect'

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

export type ClaudeFrame =
  | { kind: 'control_response'; requestId: string; ok: true; response: Record<string, unknown> }
  | { kind: 'control_response'; requestId: string; ok: false; error: string }
  | { kind: 'control_request'; requestId: string; subtype: string; request: Record<string, unknown> }
  | { kind: 'message'; type: string; subtype: string | null; body: Record<string, unknown> } // system/assistant/user/result/rate_limit_event/…

/** null when the line is not JSON, or is JSON that fits none of the shapes above. */
export function decodeClaudeFrame(line: string): ClaudeFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const o = obj(parsed)
  if (!o) return null
  const type = str(o.type)
  if (type === null) return null

  if (type === 'control_response') {
    const response = obj(o.response)
    const requestId = response ? str(response.request_id) : null
    if (!response || requestId === null) return null
    if (response.subtype === 'success') return { kind: 'control_response', requestId, ok: true, response: obj(response.response) ?? {} }
    if (response.subtype === 'error') return { kind: 'control_response', requestId, ok: false, error: str(response.error) ?? '' }
    return null
  }

  if (type === 'control_request') {
    const requestId = str(o.request_id)
    const request = obj(o.request)
    const subtype = request ? str(request.subtype) : null
    if (requestId === null || !request || subtype === null) return null
    return { kind: 'control_request', requestId, subtype, request }
  }

  return { kind: 'message', type, subtype: str(o.subtype), body: o }
}

export function encodeUserTurn(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null })
}

export function encodeControlRequest(requestId: string, request: Record<string, unknown>): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request })
}

export function encodeControlSuccess(requestId: string, response: Record<string, unknown>): string {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
}

export function encodeControlError(requestId: string, error: string): string {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })
}

export const CLAUDE_STREAM_ARGS: readonly string[] = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--setting-sources=user,project,local'
]

export function claudeLaunchArgs(a: { resumeSessionId?: string; bypass: boolean; model?: string | null }): string[] {
  return [
    ...CLAUDE_STREAM_ARGS,
    ...(a.resumeSessionId ? [`--resume=${a.resumeSessionId}`] : []),
    ...(a.bypass ? ['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions'] : []),
    ...(a.model ? ['--model', a.model] : [])
  ]
}

/** `initialize`'s or `list_models`' response -> the picker list. */
export function claudeModelsOf(response: unknown): ModelDescriptor[] {
  return parseClaudeModels(obj(response)?.models)
}

/** A `can_use_tool` request -> the card it draws, or null for any other control_request subtype (or a
 *  shape `can_use_tool` itself cannot be read in full -- an AskUserQuestion input that fails
 *  `parseAskUserQuestion`'s own schema check, say). */
export function decodeClaudeRequest(frame: Extract<ClaudeFrame, { kind: 'control_request' }>): DecodedRequest | null {
  if (frame.subtype !== 'can_use_tool') return null
  const toolName = str(frame.request.tool_name)
  if (toolName === null) return null
  const input = obj(frame.request.input) ?? {}
  const toolUseId = str(frame.request.tool_use_id) ?? undefined

  if (toolName === 'AskUserQuestion') {
    const form = parseAskUserQuestion(input)
    if (!form) return null
    return { request: { id: frame.requestId, kind: 'question', form }, questionIds: null, toolUseId, input }
  }

  const description = frame.request.description
  const about = describeToolRequest(toolName, input) ?? {
    tool: toolName,
    lines: [typeof description === 'string' ? description : JSON.stringify(input)]
  }
  const sessionSuggestions = (arr(frame.request.permission_suggestions) ?? []).filter((s) => obj(s)?.destination === 'session')
  const decisions: ApprovalDecision[] = [
    'accept',
    ...(sessionSuggestions.length > 0 && frame.request.suppress_always_allow_rule !== true ? (['acceptForSession'] as const) : []),
    'decline'
  ]
  return {
    request: { id: frame.requestId, kind: 'approval', about, decisions },
    questionIds: null,
    toolUseId,
    input,
    suggestions: sessionSuggestions
  }
}

/** Both refusals below are the caller pairing an answer with the wrong request, never anything the CLI
 *  can send: every request `decodeClaudeRequest` returns carries its tool call's `input`, and a question
 *  answer only ever comes off a question card. A fallback would put a quietly wrong frame on the wire —
 *  an empty `updatedInput`, or an answer map built from no questions at all — and the CLI would act on
 *  it, so this throws where it used to invent a value. */
export function encodeClaudeAnswer(frame: Extract<ClaudeFrame, { kind: 'control_request' }>, decoded: DecodedRequest, answer: ChatAnswer): string {
  const input = decoded.input
  if (!input) throw new Error(`encodeClaudeAnswer: no input on request ${decoded.request.id}`)
  if (answer.kind === 'question') {
    if (decoded.request.kind !== 'question') throw new Error(`encodeClaudeAnswer: a question answer for an ${decoded.request.kind} request (${decoded.request.id})`)
    const form = decoded.request.form
    const answers = Object.fromEntries(form.questions.map((q, i) => [q.question, expectedAnswers(form, answer.answers, i).join(', ')]))
    return encodeControlSuccess(frame.requestId, { behavior: 'allow', updatedInput: { ...input, answers } })
  }
  if (answer.decision === 'acceptForSession') {
    return encodeControlSuccess(frame.requestId, { behavior: 'allow', updatedInput: input, updatedPermissions: decoded.suggestions ?? [] })
  }
  if (answer.decision === 'decline') {
    return encodeControlSuccess(frame.requestId, { behavior: 'deny', message: answer.message ?? 'User declined in Astera' })
  }
  return encodeControlSuccess(frame.requestId, { behavior: 'allow', updatedInput: input })
}

/** The wire's `permissionMode`, narrowed to the three the composer's control offers. Anything else —
 *  `bypassPermissions`, or a mode a later CLI adds — reads as `default`: see PermissionMode's own doc
 *  for why that is the honest answer rather than a fourth name nobody can pick. */
function modeOf(raw: unknown): PermissionMode {
  return isPermissionMode(raw) ? raw : 'default'
}

const working: ProtocolEffect = { type: 'event', event: { type: 'status', status: 'working' } }
const idle: ProtocolEffect = { type: 'event', event: { type: 'status', status: 'idle' } }

/** One entry of the event's `unifiedWindows`. `utilization` here is 0..1, where the statusLine payload's
 *  same-named field is already a percentage, so this is the one place the two wires differ. */
function windowOf(raw: unknown): RateLimitWindow | null {
  const w = obj(raw)
  const utilization = num(w?.utilization)
  if (utilization === null) return null
  const seconds = num(w?.resetsAt)
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round(utilization * 100))),
    resetsAt: seconds === null ? null : new Date(seconds * 1000).toISOString()
  }
}

/** Builds the rateLimit effect for all three sources (see the slice 4 records' `rate-limit-shapes.md`
 *  for the measured wire shapes). `info` is the dedicated event's own `rate_limit_info` object for
 *  `source: 'event'`, and null for the other two sources, which carry no such object on the wire and
 *  so are reported as a plain rejection. The wire's `resetsAt` is epoch seconds; RateLimitInfo's is
 *  milliseconds, converted here so nothing downstream has to remember which unit it started in. */
function rateLimitOf(info: Record<string, unknown> | null, source: RateLimitInfo['source']): ProtocolEffect {
  const seconds = num(info?.resetsAt)
  const unified = obj(info?.unifiedWindows)
  return {
    type: 'rateLimit',
    info: {
      status: str(info?.status) ?? 'rejected',
      resetsAt: seconds === null ? null : seconds * 1000,
      utilization: num(info?.utilization),
      window: str(info?.rateLimitType),
      source,
      windows: unified
        ? { session: windowOf(unified.five_hour), weekly: windowOf(unified.seven_day) }
        : null
    }
  }
}

/** What a finished turn leaves in the context, off the `result` frame's own accounting.
 *
 *  The four token fields are summed rather than `input_tokens` alone: measured against four real
 *  statusLine payloads, that sum over the context window reproduces the `used_percentage` Claude Code
 *  writes for itself, and matching what the terminal shows for the same conversation is the point.
 *
 *  null rather than zeros when there is nothing to report. An aborted turn still sends a `result` with
 *  every figure at zero, and reporting that would blank a chip that had a correct reading. */
function usageOf(b: Record<string, unknown>): ProtocolEffect | null {
  const u = obj(b.usage)
  if (!u) return null
  const usedTokens =
    (num(u.input_tokens) ?? 0) +
    (num(u.cache_creation_input_tokens) ?? 0) +
    (num(u.cache_read_input_tokens) ?? 0) +
    (num(u.output_tokens) ?? 0)
  if (usedTokens <= 0) return null
  const windowByModel: Record<string, number> = {}
  for (const [model, raw] of Object.entries(obj(b.modelUsage) ?? {})) {
    const size = num(obj(raw)?.contextWindow)
    if (size !== null && size > 0) windowByModel[model] = size
  }
  return { type: 'usage', usedTokens, windowByModel }
}

export function claudeEffectsOf(frame: Extract<ClaudeFrame, { kind: 'message' }>): ProtocolEffect[] {
  const b = frame.body

  if (frame.type === 'system' && frame.subtype === 'init') {
    const sessionId = str(b.session_id)
    if (!sessionId) return []
    const permissionMode = modeOf(b.permissionMode)
    return [
      { type: 'thread', threadId: sessionId, rolloutPath: null },
      { type: 'event', event: { type: 'model', model: { model: str(b.model), effort: str(b.effort), permissionMode } } },
      { type: 'permissionMode', mode: permissionMode },
      { type: 'turn', turnId: sessionId },
      working
    ]
  }

  if (frame.type === 'system' && frame.subtype === 'status') {
    return [{ type: 'permissionMode', mode: modeOf(b.permissionMode) }]
  }

  // An assistant frame that failed for a rate limit still means the CLI is working (it retries), so
  // the rateLimit effect rides beside `working` rather than replacing it.
  if (frame.type === 'assistant') return [working, ...(b.error === 'rate_limit' ? [rateLimitOf(null, 'assistant')] : [])]

  if (frame.type === 'user') {
    const content = arr(obj(b.message)?.content) ?? []
    const toolUseIds = content
      .map((c) => obj(c))
      .filter((c): c is Record<string, unknown> => c !== null && c.type === 'tool_result')
      .map((c) => str(c.tool_use_id))
      .filter((id): id is string => id !== null)
    return toolUseIds.map((toolUseId) => ({ type: 'resolvedTool', toolUseId }))
  }

  // The dedicated, always-informational rate-limit signal — distinct from a rejected turn's result
  // text and from an assistant frame's error, both handled below.
  if (frame.type === 'rate_limit_event') return [rateLimitOf(obj(b.rate_limit_info), 'event')]

  if (frame.type === 'result') {
    const isError = b.is_error === true
    const terminalReason = str(b.terminal_reason)
    const out: ProtocolEffect[] = [{ type: 'turn', turnId: null }]
    if (isError && terminalReason !== 'aborted_streaming') {
      const message = str(b.result) || str(b.subtype) || 'error'
      out.push({ type: 'event', event: { type: 'error', message } })
    }
    // A rejected turn has no rate_limit_info object of its own — the CLI's only tell is the same
    // limit phrase the rolling scanner watches for on screen, so the phrase test is reused rather
    // than duplicated.
    if (isError && matchesLimitPhrase(str(b.result) ?? '')) out.push(rateLimitOf(null, 'result'))
    const usage = usageOf(b)
    if (usage) out.push(usage)
    out.push(idle)
    return out
  }

  return []
}
