// The adapter core: everything a CLI adapter needs that is not the CLI's own protocol. It was lifted
// whole out of codexAdapter.ts when a second CLI (claudeAdapter.ts) turned out to need the same machine,
// so the shapes below are the ones that file grew, not new ones. It owns the one mutable thing a live
// session has — its ChatState — the client requests waiting for a reply, and the open server requests the
// UI can answer, of which the oldest is the one on screen (`queue` below). It owns no method name, no
// JSON and no wire format: an adapter hands it a `write` thunk and tells it what a decoded line meant.
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
import type { ChatState, ChatEvent, ChatRequest, ChatModel } from '../../core/chat/types'
import type { DecodedRequest, JsonRpcId } from '../../core/chat/codexProtocol'
import type { Provider } from '../../core/providers/meta'

export type AdapterMode =
  | { mode: 'fresh' }
  | { mode: 'adopt'; threadId: string | null; rolloutPath: string | null; truncated: boolean }

export interface AdapterCoreDeps {
  proc: ProcLike
  log(m: string): void
  /** Test injection; default 30_000. */
  requestTimeoutMs?: number
}

export interface OpenRequest {
  decoded: DecodedRequest
  wireId: JsonRpcId
}

export interface AdapterCore {
  /** Which CLI this session is. Kept here until ChatState carries it (Task 4). */
  readonly provider: Provider
  /** The live object — adapters read it directly and change it through `patch`. */
  readonly state: ChatState
  patch(partial: Partial<Pick<ChatState, 'status' | 'request' | 'model' | 'truncated' | 'error'>>): void
  /** Immediate, for the events that bypass the flush (ready/error/exit). Subscribers are guarded. */
  emit(e: ChatEvent): void
  on(fn: (e: ChatEvent) => void): () => void
  fail(message: string): void
  /** Once per adapter, whatever else is announced afterwards. */
  emitReady(threadId: string, rolloutPath: string | null): void
  readonly ended: boolean
  /** Client request bookkeeping: `write` puts the line on the wire, the reply comes back through
   *  `settle`, and the promise rejects on the timeout or on exit. `label` is what a timeout says it
   *  timed out on (the method); the id when the caller has nothing better. */
  request<T = unknown>(id: string, write: () => void, timeoutMs?: number, label?: string): Promise<T>
  /** False when the id is not one this core is waiting on — a replayed answer to an earlier instance. */
  settle(id: string, result: { ok: true; value: unknown } | { ok: false; error: string }): boolean
  nextId(): string
  /** Server-request queue: the head is what the pane shows. */
  openRequest(id: string, entry: OpenRequest): void
  /** Drop by id and promote the next; an empty queue goes to working if a turn is running, else idle. */
  resolveRequest(id: string): void
  /** Same, for answer(): hands the entry over so the adapter can write the reply. */
  takeRequest(id: string): OpenRequest | undefined
  /** Resolve by the tool call the request is about rather than by its id — Claude's `tool_result` echo
   *  names the `tool_use_id`, not the request. False when no open request is about that call. */
  resolveByToolUse(toolUseId: string): boolean
  setTurn(turnId: string | null): void
  turnId(): string | null
  /** A copy safe to hand out, with `outlivesApp` read live off the process. */
  snapshot(): ChatState
  onExit(code: number): void
}

const DEFAULT_TIMEOUT_MS = 30_000

/** Attaches a no-op rejection handler so a caller that fires-and-forgets (`void a.send(...)`) never
 *  turns a later timeout/exit rejection into an unhandled-rejection warning — the promise returned to
 *  the caller is the same instance, and still rejects for anyone who does await it. */
export function safe<T>(p: Promise<T>): Promise<T> {
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

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
}

export function createAdapterCore(deps: AdapterCoreDeps, mode: AdapterMode, provider: Provider = 'codex'): AdapterCore {
  const { proc, log } = deps
  const defaultTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const idPrefix = `a${randomUUID().slice(0, 8)}`
  let idCounter = 1

  let turn: string | null = null
  let ended = false

  const pending = new Map<string, Pending>()
  const open = new Map<string, OpenRequest>()
  /** The open server requests in arrival order; `queue[0]` is the one the pane is showing. A second
   *  request that lands while the first is still up waits its turn rather than replacing it — an
   *  overwrite would leave the first unanswered forever, with the server still blocking on it. */
  const queue: string[] = []
  const listeners: Array<(e: ChatEvent) => void> = []

  const state: ChatState = {
    status: 'idle',
    request: null,
    model: { model: null, effort: null, planMode: false },
    error: null,
    outlivesApp: false, // placeholder — snapshot() below reads the live value off `proc` instead
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

  function emitReady(threadId: string, rolloutPath: string | null): void {
    if (readyEmitted) return
    readyEmitted = true
    emit({ type: 'ready', threadId, rolloutPath })
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

  function patch(partial: Partial<Pick<ChatState, 'status' | 'request' | 'model' | 'truncated' | 'error'>>): void {
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

  function request<T = unknown>(id: string, write: () => void, timeoutMs?: number, label?: string): Promise<T> {
    // Nothing will ever answer a request written to a process that has gone: onExit below already
    // rejected everything that was in flight, and a new one would only sit out the full timeout before
    // saying the same thing. Refused at once, with the same message the in-flight ones got.
    if (ended) return Promise.reject(new Error('process ended'))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout: ${label ?? id}`))
      }, timeoutMs ?? defaultTimeoutMs)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      write()
    })
  }

  function settle(id: string, result: { ok: true; value: unknown } | { ok: false; error: string }): boolean {
    const entry = pending.get(id)
    if (!entry) return false // a replayed answer to an earlier app instance's request
    pending.delete(id)
    if (result.ok) entry.resolve(result.value)
    else entry.reject(new Error(result.error))
    return true
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

  function openRequest(id: string, entry: OpenRequest): void {
    open.set(id, entry)
    queue.push(id)
    if (queue[0] === id) patch({ request: entry.decoded.request, status: 'waiting' })
  }

  function resolveRequest(id: string): void {
    open.delete(id)
    dropRequest(id, turn !== null ? 'working' : 'idle')
  }

  function takeRequest(id: string): OpenRequest | undefined {
    const entry = open.get(id)
    if (!entry) return undefined
    open.delete(id)
    // The person answering is the turn carrying on, so the empty slot is 'working' rather than the
    // turn-dependent status resolveRequest uses: the reply is what unblocks the server.
    dropRequest(id, 'working')
    return entry
  }

  function resolveByToolUse(toolUseId: string): boolean {
    for (const [id, entry] of open) {
      if (entry.decoded.toolUseId !== toolUseId) continue
      resolveRequest(id)
      return true
    }
    return false
  }

  function onExit(code: number): void {
    ended = true
    for (const entry of pending.values()) entry.reject(new Error('process ended'))
    pending.clear()
    open.clear()
    queue.length = 0
    emit({ type: 'exit', code })
  }

  return {
    provider,
    state,
    patch,
    emit,
    on: (fn) => {
      listeners.push(fn)
      return () => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    fail,
    emitReady,
    get ended() {
      return ended
    },
    request,
    settle,
    nextId: () => `${idPrefix}-${idCounter++}`,
    openRequest,
    resolveRequest,
    takeRequest,
    resolveByToolUse,
    setTurn: (turnId) => {
      turn = turnId
    },
    turnId: () => turn,
    // Live from the process, not stamped at construction — the manager overrides outlivesApp on the proc
    // itself as ownership is decided, and this must track that, not a snapshot from before it was.
    snapshot: () => ({ ...state, model: { ...state.model }, outlivesApp: proc.outlivesApp === true }),
    onExit
  }
}
