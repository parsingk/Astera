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
// Lives in core/chat since the chat takeover (Task 1), so the Host runs the same adapters the app does.
import { randomUUID } from 'node:crypto'
import type { ProcLike } from '../sessions/proc'
import type { ChatState, ChatEvent, ChatRequest, ChatModel } from './types'
import type { DecodedRequest, JsonRpcId } from './codexProtocol'
import type { Provider } from '../providers/meta'

export type AdapterMode =
  | { mode: 'fresh' }
  | {
      mode: 'adopt'
      threadId: string | null
      rolloutPath: string | null
      truncated: boolean
      /** Server requests this session answered before the app restarted, by request id — read back off
       *  the Host note the adapter wrote them to. A Claude `can_use_tool` is only settled on the wire by
       *  the CLI's own `tool_result` echo, which lags our answer by however long the tool runs, so the
       *  replay can carry a request that is already answered; the Claude adapter skips those rather than
       *  showing (and letting the person answer) one twice. Absent for Codex, whose every answer is
       *  followed at once by a `serverRequest/resolved` the replay carries too. */
      answered?: string[]
    }

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
  /** Which CLI this session is — also mirrored onto state.provider (and snapshot()'s copy of it), so
   *  a caller holding only a ChatState still knows which CLI it came from. */
  readonly provider: Provider
  /** The live object — adapters read it directly and change it through `patch`. */
  readonly state: ChatState
  patch(partial: Partial<Pick<ChatState, 'status' | 'request' | 'model' | 'truncated' | 'error'>>): void
  /** Immediate, for the events that bypass the flush (ready/error/exit). Subscribers are guarded. */
  emit(e: ChatEvent): void
  on(fn: (e: ChatEvent) => void): () => void
  fail(message: string): void
  /** Once per thread id: the same id announced again says nothing, a different one is announced anew. */
  emitReady(threadId: string, rolloutPath: string | null): void
  readonly ended: boolean
  /** Client request bookkeeping: `write` puts the line on the wire, the reply comes back through
   *  `settle`, and the promise rejects on the timeout or on exit. `label` is what a timeout says it
   *  timed out on (the method); the id when the caller has nothing better. */
  request<T = unknown>(id: string, write: () => void, timeoutMs?: number, label?: string): Promise<T>
  /** False when the id is not one this core is waiting on — a replayed answer to an earlier instance. */
  settle(id: string, result: { ok: true; value: unknown } | { ok: false; error: string }): boolean
  nextId(): string
  /** Server-request queue: the head is what the pane shows. A second open for an id already in the
   *  queue is refused — the same request can never hold two slots. */
  openRequest(id: string, entry: OpenRequest): void
  /** Drop by id and promote the next; an empty queue goes to working if a turn is running, else idle. */
  resolveRequest(id: string): void
  /** Same, for answer(): hands the entry to `write` — the adapter's own line for the reply — and drops
   *  it from the queue only once that write has returned. A write that throws takes nothing out: the
   *  card is still on screen, still answerable, and the throw reaches the caller. */
  takeRequest(id: string, write: (entry: OpenRequest) => void): OpenRequest | undefined
  /** Resolve by the tool call the request is about rather than by its id — Claude's `tool_result` echo
   *  names the `tool_use_id`, not the request. Every open request about that call is resolved (the
   *  Claude adapter's own `openTools` drops them all too, and the two must agree). False when none
   *  was. */
  resolveByToolUse(toolUseId: string): boolean
  setTurn(turnId: string | null): void
  turnId(): string | null
  /** A copy safe to hand out, with `outlivesApp` read live off the process. */
  snapshot(): ChatState
  /** `stderrTail` is absent — not empty — when nobody collected it (an older Host, or the fallback
   *  child process before T1/T2): that is "we do not know", not "the process said nothing", so it
   *  must never be defaulted to a message. */
  onExit(code: number, stderrTail?: string): void
}

const DEFAULT_TIMEOUT_MS = 30_000

/** Why a client request's promise rejected, when the core is the one that rejected it: the process
 *  ended, or nothing answered in time. An error the CLI itself replied with carries no reason — it is
 *  the CLI's own words, and a caller that swallows one (codex's "no active turn") must not swallow
 *  these two as well. Adapters used to tell them apart by matching the message text. */
export type RequestFailure = 'exit' | 'timeout'

export interface RequestError extends Error {
  reason: RequestFailure
}

/** Exported for an adapter that refuses a write on its own account for one of the same two reasons —
 *  the Claude adapter's `send` after exit — so that every rejection with that message carries it. */
export function requestError(reason: RequestFailure, message: string): RequestError {
  return Object.assign(new Error(message), { reason })
}

export function isRequestError(e: unknown): e is RequestError {
  const reason = e instanceof Error ? (e as Partial<RequestError>).reason : undefined
  return reason === 'exit' || reason === 'timeout'
}

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
  return a.model === b.model && a.effort === b.effort && a.permissionMode === b.permissionMode
}

/** The one line a person reads out of a process's last words. Blank lines are skipped — a CLI that dies
 *  often prints a leading newline — and it is capped so a CLI without newlines cannot push the banner
 *  off the screen; the whole tail is still there in `errorDetail`. */
function firstLineOf(tail: string | undefined): string | null {
  const line = (tail ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return line === undefined ? null : line.slice(0, 200)
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
    model: { model: null, effort: null, permissionMode: 'default' },
    error: null,
    exitCode: null,
    errorDetail: null,
    outlivesApp: false, // placeholder — snapshot() below reads the live value off `proc` instead
    truncated: mode.mode === 'adopt' ? mode.truncated : false,
    provider
  }
  let lastEmitted: { status: ChatState['status']; request: ChatRequest | null; model: ChatModel; truncated: boolean } = {
    status: state.status,
    request: state.request,
    model: state.model,
    truncated: state.truncated
  }
  let flushScheduled = false
  /** The thread id the last `ready` carried, or null while none has been emitted — see emitReady. */
  let lastReadyThreadId: string | null = null

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

  // Guarded by the id rather than by "has one been emitted", because a session's thread id can change
  // under it: a Claude `/clear` sent as a user turn makes the CLI reset the conversation and open a new
  // one, whose `system/init` names a session id this session has never seen (measured 2026-09-16, slice
  // 4 records `slash-command-measurements.md`). Everything keyed by that id — the transcript route, the
  // scheduler's persisted key, the Host note the session is resumed from — has to be told, so a changed
  // id is announced again. Codex repeats the same id at every turn and so still says this once.
  function emitReady(threadId: string, rolloutPath: string | null): void {
    if (threadId === lastReadyThreadId) return
    lastReadyThreadId = threadId
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
    if (ended) return Promise.reject(requestError('exit', 'process ended'))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(requestError('timeout', `timeout: ${label ?? id}`))
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
    // A request id is unique per CLI process, so a second open for one already here is the adapter
    // reading the same request twice. Pushing it would put the id in the queue twice: answering it
    // would leave the ghost slot behind, showing a card nothing will ever resolve.
    if (open.has(id)) {
      log(`ignored a second open request for ${id} — one is already open`)
      return
    }
    open.set(id, entry)
    queue.push(id)
    if (queue[0] === id) patch({ request: entry.decoded.request, status: 'waiting' })
  }

  function resolveRequest(id: string): void {
    open.delete(id)
    dropRequest(id, turn !== null ? 'working' : 'idle')
  }

  function takeRequest(id: string, write: (entry: OpenRequest) => void): OpenRequest | undefined {
    const entry = open.get(id)
    if (!entry) return undefined
    // Written first, dropped second: a write that throws (a pipe that has gone) never reached the CLI,
    // so the request is still open over there and has to stay open here too — otherwise the person's
    // answer is lost with nothing on screen left to answer again.
    write(entry)
    open.delete(id)
    // The person answering is the turn carrying on, so the empty slot is 'working' rather than the
    // turn-dependent status resolveRequest uses: the reply is what unblocks the server.
    dropRequest(id, 'working')
    return entry
  }

  function resolveByToolUse(toolUseId: string): boolean {
    // Every match, not the first: one tool call can only be the subject of one request in practice, but
    // the Claude adapter's own openTools map drops every entry for the call, and the two disagreeing
    // would leave a request open here that nothing will ever resolve. Collected before resolving —
    // resolveRequest writes to `open`.
    const ids = [...open].filter(([, entry]) => entry.decoded.toolUseId === toolUseId).map(([id]) => id)
    for (const id of ids) resolveRequest(id)
    return ids.length > 0
  }

  function onExit(code: number, stderrTail?: string): void {
    ended = true
    // The reason the in-flight requests get is the process's own, when it left one. They used to all
    // read 'process ended', which told the person nothing about a CLI that a version manager refused
    // to run (design D1).
    const reason = firstLineOf(stderrTail)
    for (const entry of pending.values()) entry.reject(requestError('exit', reason ?? 'process ended'))
    pending.clear()
    open.clear()
    queue.length = 0
    // Bypasses patch()/flush() the same way fail() does (see the file banner) — exit is not a value a
    // late-mounting pane can afford to miss a coalesced tick of, and exitCode/errorDetail take no part
    // in the request/status/model diffing patch() exists for.
    state.exitCode = code
    state.errorDetail = stderrTail ?? null
    if (reason !== null) state.error = reason
    // A pane that was already open when the process died only ever hears this — it does not re-read
    // `state` on exit — so the same values that just went onto `state` have to ride the event too, or
    // an already-mounted pane keeps showing the nulls it mounted with (see ChatEvent's exit variant).
    emit({ type: 'exit', code, errorDetail: state.errorDetail, ...(reason !== null ? { error: reason } : {}) })
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
    snapshot: () => ({ ...state, model: { ...state.model }, outlivesApp: proc.outlivesApp === true, provider }),
    onExit
  }
}
