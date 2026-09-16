// The Codex adapter: drives one `codex app-server` over a ProcLike through Task 3's codec
// (core/chat/codexProtocol.ts) and exposes it as a ChatAdapter (core/chat/types.ts). It owns the one
// mutable thing a live session has — its ChatState — and the open server requests the UI can answer,
// of which the oldest is the one on screen (`queue` below).
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

/** Value equality for the plain, JSON-shaped state fields — a request rebuilt from a replayed frame is
 *  a fresh object with the same contents, and must not read as "changed". */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** The model is three known fields, so it is compared as three known fields rather than by serialising
 *  it — same answer, no allocation, and no dependence on key order. */
function sameModel(a: ChatModel, b: ChatModel): boolean {
  return a.model === b.model && a.effort === b.effort && a.planMode === b.planMode
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

  const pending = new Map<string, Pending>()
  const open = new Map<string, { decoded: DecodedRequest; wireId: JsonRpcId }>()
  /** The open server requests in arrival order; `queue[0]` is the one the pane is showing. A second
   *  request that lands while the first is still up waits its turn rather than replacing it — an
   *  overwrite would leave the first unanswered forever, with the server still blocking on it. */
  const queue: string[] = []
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
  let lastEmitted: { status: ChatState['status']; request: ChatRequest | null; model: ChatModel; truncated: boolean } = {
    status: state.status,
    request: state.request,
    model: state.model,
    truncated: state.truncated
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
    const next = { status: state.status, request: state.request, model: state.model, truncated: state.truncated }
    const requestChanged = !same(next.request, lastEmitted.request)
    // `truncated` travels on the status event rather than one of its own: a pane that hears the status
    // is exactly the pane that has to stop saying "확인하는 중", and the two always settle together.
    const statusChanged = next.status !== lastEmitted.status || next.truncated !== lastEmitted.truncated
    const modelChanged = !sameModel(next.model, lastEmitted.model)
    lastEmitted = next
    if (requestChanged) emit({ type: 'request', request: next.request })
    if (statusChanged) emit({ type: 'status', status: next.status, truncated: next.truncated })
    if (modelChanged) emit({ type: 'model', model: next.model })
  }

  function patch(partial: Partial<Pick<ChatState, 'status' | 'request' | 'model' | 'truncated'>>): void {
    Object.assign(state, partial)
    scheduleFlush()
  }

  /** An error the session has to remember, not just announce: a pane that mounts after this moment
   *  reads `state.error` and would otherwise show nothing at all. Every error emission goes through
   *  here so the two can never come apart. */
  function fail(message: string): void {
    state.error = message
    emit({ type: 'error', message })
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
    // Nothing will ever answer a request written to a process that has gone: the onExit below already
    // rejected everything that was in flight, and a new one would only sit out the full timeout before
    // saying the same thing. Refused at once, with the same message the in-flight ones got.
    if (ended) return Promise.reject(new Error('process ended'))
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

  /** Takes one request out of the queue and, if it was the one on screen, shows the next one — or
   *  clears the slot with `emptyStatus` when it was the last. An id that is not in the queue (a
   *  replayed resolution for a request answered before the restart) settles nothing. */
  function dropRequest(id: string, emptyStatus: ChatState['status']): void {
    const wasShowing = queue[0] === id
    const i = queue.indexOf(id)
    if (i >= 0) queue.splice(i, 1)
    if (!wasShowing) return
    const next = queue.length > 0 ? open.get(queue[0]) : undefined
    if (next) patch({ request: next.decoded.request, status: 'waiting' })
    else patch({ request: null, status: emptyStatus })
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
        // The first thing that is definite about the turn ends the guess a truncated replay left
        // behind — without this the flag never cleared and the pane said "확인하는 중" for ever.
        patch({ truncated: false })
        break
      case 'resolved': {
        const id = String(effect.requestId)
        open.delete(id)
        dropRequest(id, turnId !== null ? 'working' : 'idle')
        break
      }
      case 'fileChange':
        rememberFileChange(effect.itemId, effect.changes)
        break
      case 'event':
        if (effect.event.type === 'status') patch({ status: effect.event.status, truncated: false })
        else if (effect.event.type === 'model') patch({ model: effect.event.model })
        else if (effect.event.type === 'error') fail(effect.event.message)
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
      proc.write(encodeError(frame.id, UNSUPPORTED_REQUEST, `unsupported request: ${frame.method}`))
      fail(`unsupported request: ${frame.method}`)
      return
    }
    open.set(decoded.request.id, { decoded, wireId: frame.id })
    queue.push(decoded.request.id)
    if (queue[0] === decoded.request.id) patch({ request: decoded.request, status: 'waiting' })
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
    queue.length = 0
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
      // Seeded from the thread itself rather than left blank until the first thread/settings/updated:
      // the pane's model pill would otherwise read "unknown" for a fresh session, and picking an
      // effort off it would send the list's default model instead of the one the thread is on.
      // planMode stays false — a resumed thread's collaboration mode arrives with that first update.
      patch({ model: { model: info.model, effort: info.effort, planMode: false } })
      emitReady()
      proc.remember?.({ threadId, rolloutPath })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      fail(message)
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
    dropRequest(requestId, 'working')
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
      return safe(
        request('turn/interrupt', { threadId, turnId })
          .then(() => undefined)
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            // Measured: codex answers turn/interrupt with "no active turn to interrupt" when the turn
            // ended between the person pressing stop and the request arriving. The person asked for the
            // turn to be over and it is — there is nothing to report, so this resolves instead of
            // raising a toast for a race the session already won. Every other refusal still rejects.
            if (!/no active turn/i.test(message)) throw e
            log(`turn/interrupt: ${message} — the turn was already over`)
          })
      )
    },
    answer: (requestId, answer) => safe(doAnswer(requestId, answer)),
    setModel: (model, effort) => safe(Promise.resolve(patch({ model: { ...state.model, model, effort } }))),
    setPlanMode: (on) => safe(Promise.resolve(patch({ model: { ...state.model, planMode: on } }))),
    listModels: () => safe(doListModels()),
    // Live from the process, not stamped at construction — the manager (Task 5) overrides it on the
    // proc itself as ownership is decided, and this must track that, not a snapshot from before it was.
    state: () => ({ ...state, model: { ...state.model }, outlivesApp: proc.outlivesApp === true }),
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
