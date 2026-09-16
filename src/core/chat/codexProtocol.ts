// The pure codec between `codex app-server`'s JSON-RPC lines (one JSON per line, over stdio) and this
// app's ChatRequest / ChatAnswer / ChatEvent (core/chat/types.ts). No process, no Node import — the
// adapter (a later task) drives a ProcLike through this codec; everything here is a total function from
// a line (or params already parsed out of one) to a value, tested without a real server running.
// Measured facts encoded below (see .../slice2-records/appserver-measurements.md): the wire's enums are
// kebab-case strings, plan mode is a per-turn struct whose `settings.model` is required, and
// `availableDecisions` is an experimental field the generated types don't carry — read defensively.

import type { ChatRequest, ChatAnswer, ChatEvent, ApprovalDecision } from './types'
import type { AskForm } from '../prompts/askUserQuestion'
import { expectedAnswers } from '../prompts/askUserQuestion'
import type { ModelDescriptor } from '../models/types'
import { parseCodexModels } from '../models/parse'

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null)

export type JsonRpcId = string | number
export type CodexFrame =
  | { kind: 'response'; id: JsonRpcId; result?: unknown; error?: { code: number; message: string } }
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }

/** null when the line is not JSON, or is JSON that fits none of the three shapes above. */
export function decodeFrame(line: string): CodexFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const o = obj(parsed)
  if (!o) return null
  const id = o.id
  const hasId = typeof id === 'string' || typeof id === 'number'
  const method = str(o.method)
  if (method !== null) return hasId ? { kind: 'request', id, method, params: o.params } : { kind: 'notification', method, params: o.params }
  if (!hasId) return null
  const err = obj(o.error)
  if (err) return { kind: 'response', id, error: { code: typeof err.code === 'number' ? err.code : 0, message: str(err.message) ?? '' } }
  if ('result' in o) return { kind: 'response', id, result: o.result }
  return null
}

export function encodeRequest(id: JsonRpcId, method: string, params: unknown): string {
  return JSON.stringify({ id, method, params })
}
export function encodeNotification(method: string, params: unknown): string {
  return JSON.stringify({ method, params })
}
export function encodeResponse(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ id, result })
}
export function encodeError(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ id, error: { code, message } })
}
export const UNSUPPORTED_REQUEST = -32601

export const OPT_OUT_NOTIFICATIONS: readonly string[] = [
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated'
]

export function initializeParams(version: string): { clientInfo: { name: 'astera'; title: 'Astera'; version: string }; capabilities: { experimentalApi: true; optOutNotificationMethods: string[] } } {
  return { clientInfo: { name: 'astera', title: 'Astera', version }, capabilities: { experimentalApi: true, optOutNotificationMethods: [...OPT_OUT_NOTIFICATIONS] } }
}

export function threadStartParams(a: { cwd: string; bypass: boolean }): { cwd: string; approvalPolicy: 'on-request' | 'never'; sandbox: 'workspace-write' | 'danger-full-access' } {
  return { cwd: a.cwd, approvalPolicy: a.bypass ? 'never' : 'on-request', sandbox: a.bypass ? 'danger-full-access' : 'workspace-write' }
}

export function threadResumeParams(a: { threadId: string; cwd: string; bypass: boolean }): { threadId: string; cwd: string; approvalPolicy: 'on-request' | 'never'; sandbox: 'workspace-write' | 'danger-full-access'; excludeTurns: true } {
  return { ...threadStartParams(a), threadId: a.threadId, excludeTurns: true }
}

/** thread/start and thread/resume results. rolloutPath is `thread.path` when it is a string, else null. */
export function threadOf(result: unknown): { threadId: string; rolloutPath: string | null; model: string | null; effort: string | null } | null {
  const o = obj(result)
  const thread = o ? obj(o.thread) : null
  if (!o || !thread) return null
  const threadId = str(thread.id)
  if (!threadId) return null
  return { threadId, rolloutPath: str(thread.path ?? null), model: str(o.model), effort: str(o.reasoningEffort) }
}

/** The entry with mode 'plan' in a collaborationMode/list result, its reasoning_effort, else null. */
export function planEffortOf(modesResult: unknown): string | null {
  const data = arr(obj(modesResult)?.data ?? null)
  if (!data) return null
  for (const entry of data) {
    const e = obj(entry)
    if (e && e.mode === 'plan') return str(e.reasoning_effort)
  }
  return null
}

export function modelsOf(modelListResult: unknown): ModelDescriptor[] {
  return parseCodexModels(obj(modelListResult)?.data)
}

export function turnStartParams(a: {
  threadId: string; text: string; model: string | null; effort: string | null
  planMode: boolean; planEffort: string | null; threadModel: string | null
}): Record<string, unknown> {
  const effectiveModel = a.model ?? a.threadModel
  let collab: Record<string, unknown> | undefined
  if (effectiveModel && a.planMode) {
    collab = { mode: 'plan', settings: { model: effectiveModel, ...(a.planEffort ? { reasoning_effort: a.planEffort } : {}) } }
  } else if (effectiveModel && !a.planMode) {
    collab = { mode: 'default', settings: { model: effectiveModel } }
  }
  return {
    threadId: a.threadId,
    input: [{ type: 'text', text: a.text }],
    ...(a.model ? { model: a.model } : {}),
    ...(a.effort ? { effort: a.effort } : {}),
    ...(collab ? { collaborationMode: collab } : {})
  }
}

export interface FileChange {
  path: string
  kind: string
  diff: string
}
export interface DecodedRequest {
  request: ChatRequest
  questionIds: string[] | null
}

export function askFormOf(questions: unknown): AskForm {
  const list = arr(questions) ?? []
  return {
    questions: list.map((q) => {
      const qo = obj(q) ?? {}
      const options = arr(qo.options) ?? []
      return {
        header: str(qo.header) ?? '',
        question: str(qo.question) ?? '',
        options: options.map((o) => {
          const oo = obj(o) ?? {}
          return { label: str(oo.label) ?? '', description: str(oo.description) || null }
        }),
        multiSelect: false
      }
    })
  }
}

/** Kept only when `availableDecisions` is absent, or names 'acceptForSession' among its entries. */
function decisionsOf(availableDecisions: unknown): ApprovalDecision[] {
  const list = arr(availableDecisions)
  const keepAcceptForSession = list === null || list.some((d) => d === 'acceptForSession')
  return keepAcceptForSession ? ['accept', 'acceptForSession', 'decline'] : ['accept', 'decline']
}

/** A diff's lines, dropping the one trailing empty line a final newline produces. */
function diffLines(diff: string): string[] {
  const lines = diff.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function cutLines(lines: string[], max: number): string[] {
  return lines.length <= max ? lines : [...lines.slice(0, max - 1), '…']
}

/** null means "not one this adapter answers" — the caller sends encodeError(UNSUPPORTED_REQUEST). */
export function decodeServerRequest(
  frame: Extract<CodexFrame, { kind: 'request' }>,
  fileChanges: ReadonlyMap<string, FileChange[]>
): DecodedRequest | null {
  const p = obj(frame.params) ?? {}
  const id = String(frame.id)
  switch (frame.method) {
    case 'item/tool/requestUserInput':
    case 'tool/requestUserInput': {
      const questions = arr(p.questions) ?? []
      const questionIds = questions.map((q) => str(obj(q)?.id) ?? '')
      return { request: { id, kind: 'question', form: askFormOf(p.questions) }, questionIds }
    }
    case 'item/commandExecution/requestApproval': {
      const actionCommands = (arr(p.commandActions) ?? [])
        .map((a) => str(obj(a)?.command))
        .filter((c): c is string => !!c)
      const command = str(p.command)
      const lines = actionCommands.length > 0 ? actionCommands : command ? [command] : []
      const reason = str(p.reason)
      if (reason) lines.push(reason)
      return { request: { id, kind: 'approval', about: { tool: 'shell', lines }, decisions: decisionsOf(p.availableDecisions) }, questionIds: null }
    }
    case 'item/fileChange/requestApproval': {
      const itemId = str(p.itemId) ?? ''
      const changes = fileChanges.get(itemId) ?? []
      const changeLines = changes.flatMap((c) => [`${c.kind} ${c.path}`, ...diffLines(c.diff)])
      const lines = changes.length === 0 ? [itemId] : cutLines(changeLines, 60)
      return { request: { id, kind: 'approval', about: { tool: 'apply_patch', lines }, decisions: decisionsOf(p.availableDecisions) }, questionIds: null }
    }
    default:
      return null
  }
}

export function encodeAnswer(id: JsonRpcId, decoded: DecodedRequest, answer: ChatAnswer): string {
  if (answer.kind === 'approval') return encodeResponse(id, { decision: answer.decision })
  const form = decoded.request.kind === 'question' ? decoded.request.form : { questions: [] }
  const questionIds = decoded.questionIds ?? []
  const answers = Object.fromEntries(questionIds.map((qid, i) => [qid, { answers: expectedAnswers(form, answer.answers, i) }]))
  return encodeResponse(id, { answers })
}

export type ProtocolEffect =
  | { type: 'event'; event: ChatEvent }
  | { type: 'thread'; threadId: string; rolloutPath: string | null }
  | { type: 'turn'; turnId: string | null }
  | { type: 'resolved'; requestId: JsonRpcId }
  | { type: 'fileChange'; itemId: string; changes: FileChange[] }

export function effectsOf(frame: Extract<CodexFrame, { kind: 'notification' }>): ProtocolEffect[] {
  const p = obj(frame.params) ?? {}
  switch (frame.method) {
    case 'thread/started': {
      const thread = obj(p.thread)
      const threadId = thread ? str(thread.id) : null
      return threadId ? [{ type: 'thread', threadId, rolloutPath: str(thread?.path ?? null) }] : []
    }
    case 'turn/started': {
      const turnId = str(obj(p.turn)?.id ?? null)
      return turnId ? [{ type: 'turn', turnId }, { type: 'event', event: { type: 'status', status: 'working' } }] : []
    }
    case 'turn/completed': {
      const turn = obj(p.turn) ?? {}
      const out: ProtocolEffect[] = [{ type: 'turn', turnId: null }]
      if (turn.status === 'failed') {
        const message = str(obj(turn.error)?.message ?? null) ?? 'turn failed'
        out.push({ type: 'event', event: { type: 'error', message } })
      }
      out.push({ type: 'event', event: { type: 'status', status: 'idle' } })
      return out
    }
    case 'thread/settings/updated': {
      const ts = obj(p.threadSettings) ?? {}
      const collab = obj(ts.collaborationMode)
      const model = { model: str(ts.model), effort: str(ts.effort), planMode: collab?.mode === 'plan' }
      return [{ type: 'event', event: { type: 'model', model } }]
    }
    case 'serverRequest/resolved': {
      const requestId = p.requestId
      return typeof requestId === 'string' || typeof requestId === 'number' ? [{ type: 'resolved', requestId }] : []
    }
    case 'item/started': {
      const item = obj(p.item)
      if (!item || item.type !== 'fileChange') return []
      const itemId = str(item.id)
      if (!itemId) return []
      const changes = (arr(item.changes) ?? []).map((c) => {
        const co = obj(c) ?? {}
        return { path: str(co.path) ?? '', kind: str(obj(co.kind)?.type ?? null) ?? 'update', diff: str(co.diff) ?? '' }
      })
      return [{ type: 'fileChange', itemId, changes }]
    }
    case 'error': {
      const message = str(obj(p.error)?.message ?? null)
      return message === null ? [] : [{ type: 'event', event: { type: 'error', message } }]
    }
    default:
      return []
  }
}
