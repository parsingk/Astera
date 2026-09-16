// The Claude adapter: drives one `claude --output-format stream-json …` over a ProcLike through the
// codec (core/chat/claudeProtocol.ts) and exposes it as a ChatAdapter (core/chat/types.ts). Sibling of
// codexAdapter.ts, and the same shape: the protocol half only — the handshake, `handleLine`,
// `applyEffect` and the eight ChatAdapter methods. Everything that is not Claude's own wire (the
// ChatState and its coalesced emission, the client requests waiting for a reply, the queue of open
// server requests, exit) lives in ./adapterCore.ts, which both adapters share.
//
// What is Claude's alone, and where the two files therefore part company:
//  - There is no thread/start. `initialize` hands over the model catalogue and the permission mode and
//    nothing else; a fresh session's id arrives only with the first turn's `system/init`, so `ready`
//    waits for it (a resumed one is the id we asked for, and is ready at once).
//  - `system/init` repeats at the head of every turn and carries the model but no effort, so a model
//    event must not wipe an effort — or the plan mode — that is already known (see applyEffect).
//  - A finished turn takes every open permission prompt with it: the CLI does not keep a `can_use_tool`
//    open across a `result`, which is also the replay rule for a request answered before a restart.
import type { ProcLike } from '../../core/sessions/proc'
import type { ChatAdapter, ChatAnswer } from '../../core/chat/types'
import type { ModelDescriptor } from '../../core/models/types'
import type { ClaudeFrame } from '../../core/chat/claudeProtocol'
import type { ProtocolEffect } from '../../core/chat/codexProtocol'
import {
  decodeClaudeFrame, decodeClaudeRequest, encodeClaudeAnswer, encodeControlError, encodeControlRequest,
  encodeUserTurn, claudeEffectsOf, claudeModelsOf
} from '../../core/chat/claudeProtocol'
import { createAdapterCore, safe, type AdapterMode } from './adapterCore'

export interface ClaudeAdapterDeps {
  proc: ProcLike
  mode: AdapterMode
  /** Unused: Claude's `initialize` carries no clientInfo. Kept so both adapters take the same deps. */
  version: string
  log(m: string): void
  /** Test injection; default 30_000. */
  requestTimeoutMs?: number
}

/** What `send` marks the session with between writing the user turn and the `system/init` that names it.
 *  A `can_use_tool` can arrive inside that window, and the core's empty-queue status has to read the
 *  turn as running ('working') rather than as no turn at all ('idle'). */
const PENDING_TURN = 'pending'

export function createClaudeAdapter(deps: ClaudeAdapterDeps): ChatAdapter {
  const { proc, mode, log } = deps
  const core = createAdapterCore({ proc, log, requestTimeoutMs: deps.requestTimeoutMs }, mode, 'claude')

  let threadId: string | null = mode.mode === 'adopt' ? mode.threadId : null
  let models: ModelDescriptor[] = []
  /** The open `can_use_tool` requests, request id -> the tool call each is about. The core owns the
   *  queue and everything the pane reads off it; this is the one question it cannot answer for us —
   *  which ids are still open when a turn ends. */
  const openTools = new Map<string, string | undefined>()

  // ---- the wire: one place to send, one place to read a line ----

  /** Every request we make of the CLI is a control_request; the reply comes back through `core.settle`
   *  as the `response` object the codec read off the line. The subtype rides along as the label so a
   *  timeout says what timed out, not which id did. */
  function control(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = core.nextId()
    return core.request<Record<string, unknown>>(id, () => proc.write(encodeControlRequest(id, request)), undefined, String(request.subtype))
  }

  /** A finished turn takes every prompt with it (measured): an open request still on screen here is one
   *  the person can no longer answer — in a replay, one that was answered before the app restarted and
   *  whose echo the replay does not carry. The turn marker is already null by the time this runs, so the
   *  emptied queue settles on 'idle'. */
  function endOpenRequests(): void {
    for (const id of openTools.keys()) core.resolveRequest(id)
    openTools.clear()
  }

  function applyEffect(effect: ProtocolEffect): void {
    switch (effect.type) {
      case 'thread':
        if (threadId === null) {
          threadId = effect.threadId
          core.emitReady(threadId, null)
          proc.remember?.({ threadId })
        }
        break
      case 'turn':
        core.setTurn(effect.turnId)
        if (effect.turnId === null) endOpenRequests()
        // The first thing that is definite about the turn ends the guess a truncated replay left behind.
        core.patch({ truncated: false })
        break
      case 'resolvedTool': {
        for (const [id, toolUseId] of openTools) if (toolUseId === effect.toolUseId) openTools.delete(id)
        // False is ordinary: a tool result for a call that ran without asking, or one we already answered.
        core.resolveByToolUse(effect.toolUseId)
        break
      }
      case 'planMode':
        // A field patch, never a model replace: `system/status` says nothing about the model.
        core.patch({ model: { ...core.state.model, planMode: effect.on } })
        break
      case 'event':
        if (effect.event.type === 'status') core.patch({ status: effect.event.status, truncated: false })
        else if (effect.event.type === 'model') {
          // `system/init` repeats every turn with the model in force but no effort, and its plan mode
          // arrives as the `planMode` effect right behind this one — so neither is taken from here: an
          // absent effort keeps the one already known rather than blanking the pill.
          core.patch({ model: { ...effect.event.model, effort: effect.event.model.effort ?? core.state.model.effort, planMode: core.state.model.planMode } })
        } else if (effect.event.type === 'error') core.fail(effect.event.message)
        break
      default:
        // 'resolved' and 'fileChange' are Codex-only; claudeEffectsOf never emits them.
        break
    }
  }

  function handleControlRequest(frame: Extract<ClaudeFrame, { kind: 'control_request' }>): void {
    const decoded = decodeClaudeRequest(frame)
    if (!decoded) {
      // Refused on the wire as well as reported: a control_request left hanging blocks the CLI's turn.
      proc.write(encodeControlError(frame.requestId, `unsupported request: ${frame.subtype}`))
      core.fail(`unsupported request: ${frame.subtype}`)
      return
    }
    openTools.set(decoded.request.id, decoded.toolUseId)
    core.openRequest(decoded.request.id, { decoded, wireId: frame.requestId })
  }

  function handleLine(line: string): void {
    if (core.ended) return
    const frame = decodeClaudeFrame(line)
    if (!frame) return
    if (frame.kind === 'control_response') core.settle(frame.requestId, frame.ok ? { ok: true, value: frame.response } : { ok: false, error: frame.error })
    else if (frame.kind === 'control_request') handleControlRequest(frame)
    else for (const effect of claudeEffectsOf(frame)) applyEffect(effect)
  }

  proc.onLine(handleLine)
  proc.onExit(({ exitCode }) => core.onExit(exitCode))

  // ---- the public surface ----

  async function doStart(a: { cwd: string; resumeThreadId?: string; bypass: boolean }): Promise<void> {
    // cwd, --resume and the bypass flags are the manager's business: by the time this runs the process
    // is already up with those args, and all that is left to do is speak.
    if (mode.mode === 'adopt') {
      if (threadId !== null) core.emitReady(threadId, null)
      return
    }
    try {
      const response = await control({ subtype: 'initialize' })
      models = claudeModelsOf(response)
      core.patch({ model: { ...core.state.model, planMode: response.current_permission_mode === 'plan' } })
      if (a.resumeThreadId !== undefined) {
        threadId = a.resumeThreadId
        core.emitReady(threadId, null)
        proc.remember?.({ threadId })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      core.fail(message)
      proc.kill()
      throw e
    }
  }

  async function doSend(text: string): Promise<void> {
    // Nothing would ever answer a turn written to a process that has gone, and a user frame gets no
    // reply to time out on — so this says the same thing the core says to a request made after exit.
    if (core.ended) throw new Error('process ended')
    core.patch({ error: null, status: 'working' })
    core.setTurn(PENDING_TURN)
    proc.write(encodeUserTurn(text))
  }

  async function doAnswer(requestId: string, answer: ChatAnswer): Promise<void> {
    const entry = core.takeRequest(requestId)
    if (!entry) throw new Error(`no open request: ${requestId}`)
    openTools.delete(requestId)
    // encodeClaudeAnswer reads only the id off the frame — everything else it needs is in `decoded` —
    // so the frame the line came on is rebuilt from the id rather than kept alive for it.
    const frame: Extract<ClaudeFrame, { kind: 'control_request' }> = { kind: 'control_request', requestId: String(entry.wireId), subtype: 'can_use_tool', request: {} }
    proc.write(encodeClaudeAnswer(frame, entry.decoded, answer))
  }

  async function doSetModel(model: string): Promise<void> {
    await control({ subtype: 'set_model', model })
    core.patch({ model: { ...core.state.model, model } })
  }

  async function doSetPlanMode(on: boolean): Promise<void> {
    await control({ subtype: 'set_permission_mode', mode: on ? 'plan' : 'default' })
    // The `system/status` that follows says the same thing; setting it on the acknowledgement means the
    // pill turns on when the CLI agrees rather than a frame later.
    core.patch({ model: { ...core.state.model, planMode: on } })
  }

  async function doListModels(): Promise<ModelDescriptor[]> {
    if (models.length === 0) {
      try {
        models = claudeModelsOf(await control({ subtype: 'list_models' }))
      } catch (e) {
        log(`list_models failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return models
  }

  return {
    start: (a) => safe(doStart(a)),
    send: (text) => safe(doSend(text)),
    interrupt: () =>
      // Sent whether or not a turn is running — the other choice was to skip it when core.turnId() is
      // null. The CLI answers an idle interrupt harmlessly, and our own marker is only ever a guess
      // about a turn that begins and ends on the wire, so this is one fewer state to get wrong.
      safe(
        control({ subtype: 'interrupt' })
          .then(() => undefined)
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            // The core's own two refusals mean the interrupt never reached an answer: nothing was
            // stopped, and the caller has to hear about it.
            if (message === 'process ended' || message.startsWith('timeout: ')) throw e
            // An error reply is the CLI refusing, which measured means the turn ended between the person
            // pressing stop and the request landing. They asked for the turn to be over and it is.
            log(`interrupt refused: ${message} — the turn was already over`)
          })
      ),
    answer: (requestId, answer) => safe(doAnswer(requestId, answer)),
    // The effort pick is dropped: this build has no control request that sets one (it only advertises
    // `supportedEffortLevels`), so half-applying it would leave the pane claiming something untrue.
    setModel: (model) => safe(doSetModel(model)),
    setPlanMode: (on) => safe(doSetPlanMode(on)),
    listModels: () => safe(doListModels()),
    state: () => core.snapshot(),
    on: (fn) => core.on(fn),
    kill: () => proc.kill()
  }
}
