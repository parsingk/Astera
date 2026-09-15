// The Codex adapter: drives one `codex app-server` over a ProcLike through Task 3's codec
// (core/chat/codexProtocol.ts) and exposes it as a ChatAdapter (core/chat/types.ts). It owns the one
// mutable thing a live session has — its ChatState — and the one open server request the UI can answer.
//
// Two shapes matter more than the rest of the file:
//  - Replay idempotence. Client request ids carry a per-instance random prefix
//    (`a<8 hex>-<n>`), so a response to a *previous* app instance's request (found in a Host replay)
//    never matches anything in `pending` and is silently dropped — never re-shown, never re-answered.
//  - Coalesced emission. `patch()` never emits synchronously; it merges into `state` and schedules one
//    `queueMicrotask` flush that compares the merged state with what was last emitted and emits only
//    what changed (by value, not by reference — a reset back to an already-emitted value emits
//    nothing). `ready`, `error` and `exit` bypass this — they always emit at once.
import { randomUUID } from 'node:crypto'
import type { ProcLike } from '../../core/sessions/proc'
import type { ChatAdapter, ChatState, ChatEvent, ChatRequest, ChatAnswer, ChatModel } from '../../core/chat/types'
import type { ModelDescriptor } from '../../core/models/types'
import type { CodexFrame, DecodedRequest, FileChange, JsonRpcId, ProtocolEffect } from '../../core/chat/codexProtocol'
import {
  decodeFrame, encodeRequest, encodeNotification, encodeError, encodeAnswer, UNSUPPORTED_REQUEST,
  initializeParams, threadStartParams, threadResumeParams, threadOf, planEffortOf, modelsOf,
  turnStartParams, decodeServerRequest, effectsOf
} from '../../core/chat/codexProtocol'

export type AdapterMode =
  | { mode: 'fresh' }
  | { mode: 'adopt'; threadId: string | null; rolloutPath: string | null; truncated: boolean }

export interface CodexAdapterDeps {
  proc: ProcLike
  mode: AdapterMode
  version: string // for initialize.clientInfo
  log(m: string): void
  /** Test injection; default 30_000. */
  requestTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_FILE_CHANGES = 32

/** Attaches a no-op rejection handler so a caller that fires-and-forgets (`void a.send(...)`) never
 *  turns a later timeout/exit rejection into an unhandled-rejection warning — the promise returned to
 *  the caller is the same instance, and still rejects for anyone who does await it. */
function safe<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {})
  return p
}

/** Value equality for the plain, JSON-shaped state fields — a reset back to a value already emitted
 *  (e.g. the model reset at the end of a fresh start) must not read as "changed". */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function turnIdOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const turn = (result as Record<string, unknown>).turn
  if (typeof turn !== 'object' || turn === null) return null
  const id = (turn as Record<string, unknown>).id
  return typeof id === 'string' ? id : null
}

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
}

export function createCodexAdapter(deps: CodexAdapterDeps): ChatAdapter {
  const { proc, mode, version, log } = deps
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const idPrefix = `a${randomUUID().slice(0, 8)}`
  let nextId = 1

  let threadId: string | null = mode.mode === 'adopt' ? mode.threadId : null
  let rolloutPath: string | null = mode.mode === 'adopt' ? mode.rolloutPath : null
  let turnId: string | null = null
  let threadModel: string | null = null
  let planEffort: string | null = null
  let models: ModelDescriptor[] = []
  let ended = false
  let currentRequestId: string | null = null

  const pending = new Map<string, Pending>()
  const open = new Map<string, { decoded: DecodedRequest; wireId: JsonRpcId }>()
  const fileChanges = new Map<string, FileChange[]>()
  const listeners: Array<(e: ChatEvent) => void> = []

  const state: ChatState = {
    status: 'idle',
    request: null,
    model: { model: null, effort: null, planMode: false },
    error: null,
    outlivesApp: false, // placeholder — state() below reads the live value off `proc` instead
    truncated: mode.mode === 'adopt' ? mode.truncated : false
  }
  let lastEmitted: { status: ChatState['status']; request: ChatRequest | null; model: ChatModel } = {
    status: state.status,
    request: state.request,
    model: state.model
  }
  let flushScheduled = false
  let readyEmitted = false

  // A listener throwing must not become an uncaught exception, nor stop the other listeners, nor leave
  // `lastEmitted` out of sync with what was actually delivered (flush() below assigns lastEmitted before
  // calling this, so a throw here can never roll that back).
  function emit(e: ChatEvent): void {
    for (const fn of listeners) {
      try {
        fn(e)
      } catch (err) {
        log(`chat event listener threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  function emitReady(): void {
    if (readyEmitted) return
    readyEmitted = true
    emit({ type: 'ready', threadId: threadId as string, rolloutPath })
  }

  function scheduleFlush(): void {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(flush)
  }

  // Captures the values to emit (`next`) and commits them to `lastEmitted` *before* calling any
  // listener — a listener that reacts to a `request` event by synchronously patching state again (e.g.
  // `adapter.answer(...)` from inside the callback) must schedule a fresh flush that compares against
  // what this flush is about to report, not against the pre-flush snapshot; otherwise that further
  // change is invisible to the next flush and never emitted (assigning lastEmitted after emitting loses
  // exactly that change, since the reentrant patch already mutated `state` by the time this function
  // would have read it again).
  function flush(): void {
    flushScheduled = false
    const next = { status: state.status, request: state.request, model: state.model }
    const requestChanged = !same(next.request, lastEmitted.request)
    const statusChanged = !same(next.status, lastEmitted.status)
    const modelChanged = !same(next.model, lastEmitted.model)
    lastEmitted = next
    if (requestChanged) emit({ type: 'request', request: next.request })
    if (statusChanged) emit({ type: 'status', status: next.status })
    if (modelChanged) emit({ type: 'model', model: next.model })
  }

  function patch(partial: Partial<Pick<ChatState, 'status' | 'request' | 'model'>>): void {
    Object.assign(state, partial)
    scheduleFlush()
  }

  function rememberFileChange(itemId: string, changes: FileChange[]): void {
    fileChanges.set(itemId, changes)
    if (fileChanges.size > MAX_FILE_CHANGES) {
      const oldest = fileChanges.keys().next().value
      if (oldest !== undefined) fileChanges.delete(oldest)
    }
  }

  // ---- the wire: one place to send, one place to read a line ----

  function request(method: string, params: unknown): Promise<unknown> {
    const id = `${idPrefix}-${nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      proc.write(encodeRequest(id, method, params))
    })
  }

  function notify(method: string, params: unknown): void {
    proc.write(encodeNotification(method, params))
  }

  function applyEffect(effect: ProtocolEffect): void {
    switch (effect.type) {
      case 'thread':
        if (threadId === null) {
          threadId = effect.threadId
          rolloutPath = effect.rolloutPath
          emitReady()
        }
        break
      case 'turn':
        turnId = effect.turnId
        break
      case 'resolved': {
        const id = String(effect.requestId)
        open.delete(id)
        if (currentRequestId === id) {
          currentRequestId = null
          patch({ request: null, status: turnId !== null ? 'working' : 'idle' })
        }
        break
      }
      case 'fileChange':
        rememberFileChange(effect.itemId, effect.changes)
        break
      case 'event':
        if (effect.event.type === 'status') patch({ status: effect.event.status })
        else if (effect.event.type === 'model') patch({ model: effect.event.model })
        else if (effect.event.type === 'error') {
          state.error = effect.event.message
          emit(effect.event)
        }
        break
    }
  }

  function handleResponse(frame: Extract<CodexFrame, { kind: 'response' }>): void {
    const entry = pending.get(String(frame.id))
    if (!entry) return // a replayed answer to an earlier app instance's request
    pending.delete(String(frame.id))
    if (frame.error) entry.reject(new Error(frame.error.message))
    else entry.resolve(frame.result)
  }

  function handleServerRequest(frame: Extract<CodexFrame, { kind: 'request' }>): void {
    const decoded = decodeServerRequest(frame, fileChanges)
    if (!decoded) {
      const message = `unsupported request: ${frame.method}`
      proc.write(encodeError(frame.id, UNSUPPORTED_REQUEST, message))
      emit({ type: 'error', message })
      return
    }
    open.set(decoded.request.id, { decoded, wireId: frame.id })
    currentRequestId = decoded.request.id
    patch({ request: decoded.request, status: 'waiting' })
  }

  function handleLine(line: string): void {
    if (ended) return
    const frame = decodeFrame(line)
    if (!frame) return
    if (frame.kind === 'response') handleResponse(frame)
    else if (frame.kind === 'request') handleServerRequest(frame)
    else for (const effect of effectsOf(frame)) applyEffect(effect)
  }

  proc.onLine(handleLine)
  proc.onExit(({ exitCode }) => {
    ended = true
    for (const entry of pending.values()) entry.reject(new Error('process ended'))
    pending.clear()
    open.clear()
    currentRequestId = null
    emit({ type: 'exit', code: exitCode })
  })

  // ---- the public surface ----

  async function doStart(a: { cwd: string; resumeThreadId?: string; bypass: boolean }): Promise<void> {
    if (mode.mode === 'adopt') {
      if (threadId !== null) emitReady()
      return
    }
    try {
      await request('initialize', initializeParams(version))
      notify('initialized', {})
      // Neither list call is fatal: a thread can start (and be talked to) without knowing the plan
      // effort or the model catalogue, so a failure here only means the feature that needed it degrades
      // (no reasoning_effort in the plan struct, an empty model list) — never a reason to end the session.
      const collabP = request('collaborationMode/list', {}).catch((err: unknown) => {
        log(`collaborationMode/list failed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      })
      const modelP = request('model/list', { includeHidden: false }).catch((err: unknown) => {
        log(`model/list failed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      })
      const [collabResult, modelResult] = await Promise.all([collabP, modelP])
      planEffort = collabResult === null ? null : planEffortOf(collabResult)
      models = modelResult === null ? [] : modelsOf(modelResult)
      const threadResult = a.resumeThreadId
        ? await request('thread/resume', threadResumeParams({ threadId: a.resumeThreadId, cwd: a.cwd, bypass: a.bypass }))
        : await request('thread/start', threadStartParams({ cwd: a.cwd, bypass: a.bypass }))
      const info = threadOf(threadResult)
      if (!info) throw new Error('thread/start: malformed result')
      threadId = info.threadId
      rolloutPath = info.rolloutPath
      threadModel = info.model
      patch({ model: { model: null, effort: null, planMode: false } })
      emitReady()
      proc.remember?.({ threadId, rolloutPath })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      emit({ type: 'error', message })
      proc.kill()
      throw e
    }
  }

  async function doSend(text: string): Promise<void> {
    if (threadId === null) throw new Error('no active thread')
    state.error = null
    const result = await request(
      'turn/start',
      turnStartParams({
        threadId, text, model: state.model.model, effort: state.model.effort,
        planMode: state.model.planMode, planEffort, threadModel
      })
    )
    const tid = turnIdOf(result)
    if (tid !== null) turnId = tid
    patch({ status: 'working' })
  }

  async function doAnswer(requestId: string, answer: ChatAnswer): Promise<void> {
    const entry = open.get(requestId)
    if (!entry) throw new Error(`no open request: ${requestId}`)
    proc.write(encodeAnswer(entry.wireId, entry.decoded, answer))
    open.delete(requestId)
    if (currentRequestId === requestId) {
      currentRequestId = null
      patch({ request: null, status: 'working' })
    }
  }

  async function doListModels(): Promise<ModelDescriptor[]> {
    if (models.length === 0) {
      try {
        models = modelsOf(await request('model/list', { includeHidden: false }))
      } catch (e) {
        log(`model/list failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return models
  }

  return {
    start: (a) => safe(doStart(a)),
    send: (text) => safe(doSend(text)),
    interrupt: () => {
      if (threadId === null || turnId === null) return Promise.resolve()
      return safe(request('turn/interrupt', { threadId, turnId }).then(() => undefined))
    },
    answer: (requestId, answer) => safe(doAnswer(requestId, answer)),
    setModel: (model, effort) => safe(Promise.resolve(patch({ model: { ...state.model, model, effort } }))),
    setPlanMode: (on) => safe(Promise.resolve(patch({ model: { ...state.model, planMode: on } }))),
    listModels: () => safe(doListModels()),
    // Live from the process, not stamped at construction — the manager (Task 5) overrides it on the
    // proc itself as ownership is decided, and this must track that, not a snapshot from before it was.
    state: () => ({ ...state, outlivesApp: proc.outlivesApp === true }),
    on: (fn) => {
      listeners.push(fn)
      return () => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    kill: () => proc.kill()
  }
}
