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
//    waits for it (a resumed one is the id we asked for, and is ready at once). The id is not settled
//    for good either: a `/clear` starts a new conversation under a new id, and `ready` says so again.
//  - `system/init` repeats at the head of every turn and carries the model but no effort, so a model
//    event must not wipe an effort — or the plan mode — that is already known (see applyEffect).
//  - A finished turn takes every open permission prompt with it: the CLI does not keep a `can_use_tool`
//    open across a `result`, so a replayed turn that ends in one leaves no card behind either.
//  - A `can_use_tool` is settled on the wire only by the CLI's own `tool_result` echo, which lags our
//    answer by the tool's run time. A request answered inside that window has no echo behind it in the
//    replay, so it is skipped by id instead (`answered` below, ruling S3-7).
import type { ProcLike } from '../../core/sessions/proc'
import type { ChatAdapter, ChatAnswer, PermissionMode } from '../../core/chat/types'
import { isPermissionMode } from '../../core/chat/types'
import type { ModelDescriptor } from '../../core/models/types'
import type { ClaudeFrame } from '../../core/chat/claudeProtocol'
import type { ProtocolEffect } from '../../core/chat/codexProtocol'
import {
  decodeClaudeFrame, decodeClaudeRequest, encodeClaudeAnswer, encodeControlError, encodeControlRequest,
  encodeUserTurn, claudeEffectsOf, claudeModelsOf
} from '../../core/chat/claudeProtocol'
import { createAdapterCore, isRequestError, requestError, safe, type AdapterMode } from './adapterCore'

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

/** How many answered request ids are kept in the note. The replay only ever carries the CLI's recent
 *  output, so a handful would do; this is small enough to write on every answer and long enough that
 *  the window can never outrun it. */
const ANSWERED_KEPT = 32

/** The three the composer's mode menu offers, in the order it draws them. `bypassPermissions` is
 *  deliberately absent — see PermissionMode (core/chat/types.ts). */
const CLAUDE_PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan']

export function createClaudeAdapter(deps: ClaudeAdapterDeps): ChatAdapter {
  const { proc, mode, log } = deps
  const core = createAdapterCore({ proc, log, requestTimeoutMs: deps.requestTimeoutMs }, mode, 'claude')

  /** The CLI's session id, followed rather than learned once. A `/clear` sent as a user turn resets the
   *  conversation and the next `system/init` names a new id (measured 2026-09-16), and this session is
   *  that conversation whatever it is now called — so a changed id replaces this one, is announced
   *  again, and is written to the note the session would be resumed from. */
  let threadId: string | null = mode.mode === 'adopt' ? mode.threadId : null
  let models: ModelDescriptor[] = []
  /** The open `can_use_tool` requests, request id -> the tool call each is about. The core owns the
   *  queue and everything the pane reads off it; this is the one question it cannot answer for us —
   *  which ids are still open when a turn ends. */
  const openTools = new Map<string, string | undefined>()
  /** The `can_use_tool` requests this session has answered, newest last, written to the Host note on
   *  every answer and read back out of it after a restart (ruling S3-7).
   *
   *  Claude's only settle mark for a request is the CLI's own `tool_result` echo, and that lags our
   *  answer by however long the tool runs — so the replay an adopted session reads can carry a request
   *  that is already answered, with no echo behind it to clear it. Shown, it would be answered twice:
   *  once by the app that is gone and once by the person looking at it now. This list is what tells the
   *  two apart. Codex needs none of it, because its `serverRequest/resolved` follows every answer at
   *  once and the replay carries that too. */
  const answered: string[] = mode.mode === 'adopt' ? [...(mode.answered ?? [])] : []

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
   *  whose echo the replay does not carry (the `answered` note catches most of those before they are
   *  ever opened; this catches what no note names). The turn marker is already null by the time this
   *  runs, so the emptied queue settles on 'idle'. */
  function endOpenRequests(): void {
    if (openTools.size === 0) return
    // Said out loud: a card disappearing on its own is the kind of thing whose only trace should not be
    // the screen it left.
    log(`the turn ended with ${openTools.size} open request(s) — the CLI keeps none across a result`)
    for (const id of openTools.keys()) core.resolveRequest(id)
    openTools.clear()
  }

  /** Remembers a request as answered, for a replay after a restart to skip — see `answered`. The note
   *  is fire-and-forget, the same as `remember({ threadId })`: a Host that does not take it costs this
   *  session nothing while it runs, and the list is rewritten whole on the next answer anyway. */
  function rememberAnswered(requestId: string): void {
    answered.push(requestId)
    if (answered.length > ANSWERED_KEPT) answered.splice(0, answered.length - ANSWERED_KEPT)
    proc.remember?.({ answered: [...answered] })
  }

  function applyEffect(effect: ProtocolEffect): void {
    switch (effect.type) {
      case 'thread':
        // `system/init` repeats at the head of every turn, so this is a change test, not a first-time
        // one: the same id says nothing, a different one is the `/clear` case above.
        if (threadId !== effect.threadId) {
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
      case 'permissionMode':
        // A field patch, never a model replace: `system/status` says nothing about the model.
        core.patch({ model: { ...core.state.model, permissionMode: effect.mode } })
        break
      case 'event':
        if (effect.event.type === 'status') {
          // A card on screen outranks 'working'. The CLI goes on talking while it waits for an answer
          // (every assistant frame means 'working'), and the person is being asked a question — the
          // status that says so stays until the answer or the turn's end takes the card away, both of
          // which come through the core's own empty-queue status rather than through here. 'idle' is
          // not guarded: it only ever arrives with the `result` that has already emptied the queue.
          if (effect.event.status === 'working' && core.state.request !== null) core.patch({ truncated: false })
          else core.patch({ status: effect.event.status, truncated: false })
        } else if (effect.event.type === 'model') {
          // `system/init` repeats every turn with the model in force but no effort, and its permission
          // mode arrives as the `permissionMode` effect right behind this one — so neither is taken from
          // here: an absent effort keeps the one already known rather than blanking the readout.
          core.patch({ model: { ...effect.event.model, effort: effect.event.model.effort ?? core.state.model.effort, permissionMode: core.state.model.permissionMode } })
        } else if (effect.event.type === 'error') core.fail(effect.event.message)
        break
      case 'rateLimit':
        // Immediate, not folded into ChatState: rolling and Slack read it off the event stream, and the
        // pane draws nothing from it, so there is no state field for `patch` to coalesce it into.
        core.emit({ type: 'rateLimit', info: effect.info })
        break
      case 'usage':
        // Same arrangement, and for the same reason: the status bar reads it off the stream and the
        // pane draws nothing from it.
        core.emit({ type: 'usage', context: { usedTokens: effect.usedTokens, windowByModel: effect.windowByModel } })
        break
      default:
        // 'resolved' and 'fileChange' are Codex-only; claudeEffectsOf never emits them.
        break
    }
  }

  /** Refused on the wire as well as reported: a control_request left hanging blocks the CLI's turn. */
  function refuseRequest(requestId: string, reason: string): void {
    proc.write(encodeControlError(requestId, reason))
    core.fail(reason)
  }

  function handleControlRequest(frame: Extract<ClaudeFrame, { kind: 'control_request' }>): void {
    // Before anything is decoded or written: this one was answered by the process that is gone, and the
    // only right thing to do with it is nothing at all. Request ids are unique per CLI process, so a
    // live request can never carry an answered id and this needs no "the replay is over" marker.
    if (frame.subtype === 'can_use_tool' && answered.includes(frame.requestId)) {
      log(`skipped a replayed can_use_tool ${frame.requestId}: answered before the restart`)
      return
    }
    const decoded = decodeClaudeRequest(frame)
    if (!decoded) {
      // Two different failures, said apart: a subtype this build has no card for, and a `can_use_tool`
      // whose own input would not read (an AskUserQuestion that fails parseAskUserQuestion, say).
      const toolName = typeof frame.request.tool_name === 'string' ? frame.request.tool_name : '?'
      refuseRequest(frame.requestId, frame.subtype === 'can_use_tool' ? `unreadable request: can_use_tool ${toolName}` : `unsupported request: ${frame.subtype}`)
      return
    }
    openTools.set(decoded.request.id, decoded.toolUseId)
    core.openRequest(decoded.request.id, { decoded, wireId: frame.requestId })
  }

  /** A `control_request` line the codec could not read at all — no `request` object, or a subtype that
   *  is not a string — comes back from `decodeClaudeFrame` as null, indistinguishable from any other
   *  unreadable line. The CLI is still blocked on it, so the raw line is looked at once more for the
   *  one field an answer needs. Null when the line is not a control_request at all (the ordinary case
   *  for an unreadable line, and none of this adapter's business); a null `requestId` when it is one
   *  but names no request, where there is nothing to answer and inventing an id would answer
   *  somebody else's. */
  function unreadableControlRequest(line: string): { requestId: string | null } | null {
    try {
      const o: unknown = JSON.parse(line)
      if (typeof o !== 'object' || o === null) return null
      const { type, request_id: requestId } = o as { type?: unknown; request_id?: unknown }
      if (type !== 'control_request') return null
      return { requestId: typeof requestId === 'string' ? requestId : null }
    } catch {
      return null
    }
  }

  function handleLine(line: string): void {
    if (core.ended) return
    const frame = decodeClaudeFrame(line)
    if (!frame) {
      const raw = unreadableControlRequest(line)
      if (!raw) return
      if (raw.requestId !== null) refuseRequest(raw.requestId, 'unsupported request: ?')
      else log('dropped a control_request that names no request_id — there is nothing to answer')
      return
    }
    if (frame.kind === 'control_response') core.settle(frame.requestId, frame.ok ? { ok: true, value: frame.response } : { ok: false, error: frame.error })
    else if (frame.kind === 'control_request') handleControlRequest(frame)
    else for (const effect of claudeEffectsOf(frame)) applyEffect(effect)
  }

  proc.onLine(handleLine)
  proc.onExit(({ exitCode, stderrTail }) => core.onExit(exitCode, stderrTail))

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
      core.patch({
        model: {
          ...core.state.model,
          // Same narrowing the wire's own frames get (modeOf, core/chat/claudeProtocol.ts): a session
          // started in bypassPermissions reads as default rather than as a mode the menu cannot show.
          permissionMode: isPermissionMode(response.current_permission_mode)
            ? response.current_permission_mode
            : 'default'
        }
      })
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
    if (core.ended) throw requestError('exit', 'process ended')
    core.patch({ error: null, status: 'working' })
    core.setTurn(PENDING_TURN)
    proc.write(encodeUserTurn(text))
  }

  async function doAnswer(requestId: string, answer: ChatAnswer): Promise<void> {
    // The write goes through the core so that a write which throws leaves the card open — see
    // takeRequest's own doc. encodeClaudeAnswer reads only the id off the frame — everything else it
    // needs is in `decoded` — so the frame the line came on is rebuilt from the id rather than kept
    // alive for it.
    const entry = core.takeRequest(requestId, (e) => {
      const frame: Extract<ClaudeFrame, { kind: 'control_request' }> = { kind: 'control_request', requestId: String(e.wireId), subtype: 'can_use_tool', request: {} }
      proc.write(encodeClaudeAnswer(frame, e.decoded, answer))
    })
    if (!entry) throw new Error(`no open request: ${requestId}`)
    openTools.delete(requestId)
    // Only once the answer is actually on the wire — a write that threw answered nothing, and noting it
    // would hide the request from the replay that is the person's one chance to answer it again.
    rememberAnswered(requestId)
  }

  async function doSetModel(model: string): Promise<void> {
    await control({ subtype: 'set_model', model })
    core.patch({ model: { ...core.state.model, model } })
  }

  async function doSetPermissionMode(mode: PermissionMode): Promise<void> {
    await control({ subtype: 'set_permission_mode', mode })
    // The `system/status` that follows says the same thing; setting it on the acknowledgement means the
    // control moves when the CLI agrees rather than a frame later.
    core.patch({ model: { ...core.state.model, permissionMode: mode } })
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
            // The core's own two refusals (the process ended, nothing answered in time) mean the
            // interrupt never reached an answer: nothing was stopped, and the caller has to hear about
            // it. They say so on the error itself — see isRequestError.
            if (isRequestError(e)) throw e
            // What is left is an error reply, the CLI refusing, which measured means the turn ended
            // between the person pressing stop and the request landing. They asked for the turn to be
            // over and it is.
            log(`interrupt refused: ${e instanceof Error ? e.message : String(e)} — the turn was already over`)
          })
      ),
    answer: (requestId, answer) => safe(doAnswer(requestId, answer)),
    // The effort pick is dropped: this build has no control request that sets one (it only advertises
    // `supportedEffortLevels`), so half-applying it would leave the pane claiming something untrue.
    setModel: (model) => safe(doSetModel(model)),
    setPermissionMode: (mode) => safe(doSetPermissionMode(mode)),
    // No round trip: Claude's set is fixed and it names none of them on the wire. The empty label is
    // the contract's own cue for that (PermissionModeChoice) — the composer supplies a translated word.
    // Least permissive first, plan last: it is the one people reach for deliberately.
    listPermissionModes: () =>
      Promise.resolve(CLAUDE_PERMISSION_MODES.map((key) => ({ key, label: '' }))),
    listModels: () => safe(doListModels()),
    state: () => core.snapshot(),
    on: (fn) => core.on(fn),
    kill: () => proc.kill()
  }
}
