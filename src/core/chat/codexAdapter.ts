// The Codex adapter: drives one `codex app-server` over a ProcLike through the codec
// (core/chat/codexProtocol.ts) and exposes it as a ChatAdapter (core/chat/types.ts). It is the protocol
// half only — the handshake, `handleLine`, `applyEffect` and the eight ChatAdapter methods. Everything
// that is not app-server's own wire (the ChatState and its coalesced emission, the client requests
// waiting for a reply, the queue of open server requests, exit) lives in ./adapterCore.ts, which the
// Claude adapter shares; read that file for why those pieces are shaped the way they are.
// Lives in core/chat since the chat takeover (Task 1), so the Host runs the same adapters the app does.
import type { ProcLike } from '../sessions/proc'
import type { ChatAdapter, ChatAnswer, PermissionModeChoice } from './types'
import type { ModelDescriptor } from '../models/types'
import type { CodexFrame, FileChange, ProtocolEffect } from './codexProtocol'
import {
  decodeFrame, encodeRequest, encodeNotification, encodeError, encodeAnswer, UNSUPPORTED_REQUEST,
  initializeParams, threadStartParams, threadResumeParams, threadOf, planEffortOf, modelsOf,
  permissionModesOf,
  turnStartParams, decodeServerRequest, effectsOf
} from './codexProtocol'
import { createAdapterCore, safe, type AdapterMode } from './adapterCore'

export type { AdapterMode }

export interface CodexAdapterDeps {
  proc: ProcLike
  mode: AdapterMode
  version: string // for initialize.clientInfo
  log(m: string): void
  /** Test injection; default 30_000. */
  requestTimeoutMs?: number
}

const MAX_FILE_CHANGES = 32

/** How many answered request ids are kept in the note, the same bound as the Claude adapter's. */
const ANSWERED_KEPT = 32

function turnIdOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const turn = (result as Record<string, unknown>).turn
  if (typeof turn !== 'object' || turn === null) return null
  const id = (turn as Record<string, unknown>).id
  return typeof id === 'string' ? id : null
}

export function createCodexAdapter(deps: CodexAdapterDeps): ChatAdapter {
  const { proc, mode, version, log } = deps
  const core = createAdapterCore({ proc, log, requestTimeoutMs: deps.requestTimeoutMs }, mode, 'codex')

  let threadId: string | null = mode.mode === 'adopt' ? mode.threadId : null
  let rolloutPath: string | null = mode.mode === 'adopt' ? mode.rolloutPath : null
  let threadModel: string | null = null
  let planEffort: string | null = null
  /** What `collaborationMode/list` answered, for the composer's mode menu. Filled at startup, or on
   *  first use for a session that had no startup to fill it (see doListPermissionModes). */
  let permissionModes: PermissionModeChoice[] = []
  /** Whether that list has been asked for and answered — however it answered. Separate from the array
   *  being empty, because empty is also the honest answer for a CLI that refuses the call, and without
   *  this the menu would ask again on every open for the rest of the session. */
  let permissionModesAsked = false
  let models: ModelDescriptor[] = []
  // The person's own explicit picks, kept apart from `state.model` (which also carries the thread's own
  // model/effort, seeded from thread/start purely for display — F2). A fresh session where the person
  // has picked nothing must send no top-level model/effort on turn/start, exactly as before F2; only
  // `setModel` ever writes here.
  let picked: { model: string | null; effort: string | null } = { model: null, effort: null }

  const fileChanges = new Map<string, FileChange[]>()
  /** The server requests this session has answered, newest last, written to the Host note on every
   *  answer, as the Claude adapter writes its own (CT-8). The adapter itself needs none of it: the
   *  replay carries `serverRequest/resolved` after every answer. A Host that is only a reader does: its
   *  own adapter keeps the request open until that echo reaches it, and every Host view of the queue
   *  (`prompts`, `requests`, the deny policy) filters the note's ids. Seeded from the note on adopt so
   *  the list is rewritten whole, not restarted. */
  const answered: string[] = mode.mode === 'adopt' ? [...(mode.answered ?? [])] : []

  function rememberFileChange(itemId: string, changes: FileChange[]): void {
    fileChanges.set(itemId, changes)
    if (fileChanges.size > MAX_FILE_CHANGES) {
      const oldest = fileChanges.keys().next().value
      if (oldest !== undefined) fileChanges.delete(oldest)
    }
  }

  // ---- the wire: one place to send, one place to read a line ----

  function request(method: string, params: unknown): Promise<unknown> {
    const id = core.nextId()
    // The method rides along as the label so a timeout says what timed out, not which id did.
    return core.request(id, () => proc.write(encodeRequest(id, method, params)), undefined, method)
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
          core.emitReady(threadId, rolloutPath)
        }
        break
      case 'turn':
        core.setTurn(effect.turnId)
        // The first thing that is definite about the turn ends the guess a truncated replay left
        // behind — without this the flag never cleared and the pane said "확인하는 중" for ever.
        core.patch({ truncated: false })
        // A turn beginning retires the last one's failure, as `doSend` does for a turn this adapter
        // sent. The turn may have been sent by another process (the Host while the app was away, or
        // the app while this Host adapter only reads), and `turn/started` is the only sign of it.
        if (effect.turnId !== null) core.patch({ error: null })
        break
      case 'resolved':
        core.resolveRequest(String(effect.requestId))
        break
      case 'fileChange':
        rememberFileChange(effect.itemId, effect.changes)
        break
      case 'event':
        if (effect.event.type === 'status') core.patch({ status: effect.event.status, truncated: false })
        // The known effort survives an update that carries none. `thread/settings/updated` is the
        // whole of the thread's settings, but its `effort` is nullable, and thread/start above has
        // already seeded a real one — so replacing the object wholesale dropped the readout's "@ xhigh"
        // every time an update arrived without one, and put it back on the next one that had it.
        // Reported as "the model keeps changing during a conversation". The model name gets the same
        // guard for the same reason: losing it sends the composer back to naming the account's default
        // instead, which is a different name again. claudeAdapter has kept the effort this way since it
        // was written; this is that rule, here. planMode is not guarded — codex derives it from the
        // collaborationMode on the very same update, so the update is the authority on it.
        else if (effect.event.type === 'model')
          core.patch({
            model: {
              ...effect.event.model,
              model: effect.event.model.model ?? core.state.model.model,
              effort: effect.event.model.effort ?? core.state.model.effort
            }
          })
        else if (effect.event.type === 'error') core.fail(effect.event.message)
        break
      default:
        // 'resolvedTool' and 'planMode' are Claude-only effects; effectsOf (Codex) never emits them.
        break
    }
  }

  function handleResponse(frame: Extract<CodexFrame, { kind: 'response' }>): void {
    core.settle(String(frame.id), frame.error ? { ok: false, error: frame.error.message } : { ok: true, value: frame.result })
  }

  function handleServerRequest(frame: Extract<CodexFrame, { kind: 'request' }>): void {
    const decoded = decodeServerRequest(frame, fileChanges)
    if (!decoded) {
      proc.write(encodeError(frame.id, UNSUPPORTED_REQUEST, `unsupported request: ${frame.method}`))
      core.fail(`unsupported request: ${frame.method}`)
      return
    }
    core.openRequest(decoded.request.id, { decoded, wireId: frame.id })
  }

  function handleLine(line: string): void {
    if (core.ended) return
    const frame = decodeFrame(line)
    if (!frame) return
    if (frame.kind === 'response') handleResponse(frame)
    else if (frame.kind === 'request') handleServerRequest(frame)
    else for (const effect of effectsOf(frame)) applyEffect(effect)
  }

  proc.onLine(handleLine)
  proc.onExit(({ exitCode, stderrTail }) => core.onExit(exitCode, stderrTail))

  // ---- the public surface ----

  async function doStart(a: { cwd: string; resumeThreadId?: string; bypass: boolean }): Promise<void> {
    if (mode.mode === 'adopt') {
      if (threadId !== null) core.emitReady(threadId, rolloutPath)
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
      permissionModes = collabResult === null ? [] : permissionModesOf(collabResult)
      permissionModesAsked = true
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
      // The mode stays at default — a resumed thread's collaboration mode arrives with that first update.
      core.patch({ model: { model: info.model, effort: info.effort, permissionMode: 'default' } })
      core.emitReady(threadId, rolloutPath)
      proc.remember?.({ threadId, rolloutPath })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      core.fail(message)
      proc.kill()
      throw e
    }
  }

  async function doSend(text: string): Promise<void> {
    if (threadId === null) throw new Error('no active thread')
    core.patch({ error: null })
    const result = await request(
      'turn/start',
      turnStartParams({
        threadId, text, model: picked.model, effort: picked.effort,
        planMode: core.state.model.permissionMode === 'plan', planEffort, threadModel
      })
    )
    const tid = turnIdOf(result)
    if (tid !== null) core.setTurn(tid)
    core.patch({ status: 'working' })
  }

  async function doAnswer(requestId: string, answer: ChatAnswer): Promise<void> {
    // The write goes through the core so that a write which throws leaves the card open — see
    // takeRequest's own doc.
    const entry = core.takeRequest(requestId, (e) => proc.write(encodeAnswer(e.wireId, e.decoded, answer)))
    if (!entry) throw new Error(`no open request: ${requestId}`)
    // Only once the answer is on the wire: a write that threw answered nothing.
    answered.push(requestId)
    if (answered.length > ANSWERED_KEPT) answered.splice(0, answered.length - ANSWERED_KEPT)
    proc.remember?.({ answered: [...answered] })
  }

  /** The modes, asked for on first use when the startup list never ran. A session the Host already had
   *  is adopted without a handshake (doStart's own branch), so its startup never happened and this is
   *  the only thing that fills the menu — the same shape `doListModels` beside it already uses, and for
   *  the same reason. A refusal answers empty and is not asked again. */
  async function doListPermissionModes(): Promise<PermissionModeChoice[]> {
    if (!permissionModesAsked) {
      permissionModesAsked = true
      try {
        permissionModes = permissionModesOf(await request('collaborationMode/list', {}))
      } catch (e) {
        log(`collaborationMode/list failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return permissionModes
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
      const turnId = core.turnId()
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
    setModel: (model, effort) => {
      picked = { model, effort }
      return safe(Promise.resolve(core.patch({ model: { ...core.state.model, model, effort } })))
    },
    // Kept locally: codex takes the mode with the next turn's `collaborationMode`, not as a call of
    // its own (turnStartParams, core/chat/codexProtocol.ts).
    setPermissionMode: (mode) =>
      safe(Promise.resolve(core.patch({ model: { ...core.state.model, permissionMode: mode } }))),
    listPermissionModes: () => safe(doListPermissionModes()),
    listModels: () => safe(doListModels()),
    state: () => core.snapshot(),
    pending: () => core.openRequests(),
    on: (fn) => core.on(fn),
    kill: () => proc.kill()
  }
}
