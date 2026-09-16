import { describe, it, expect, vi } from 'vitest'
import { createClaudeAdapter } from './claudeAdapter'
import * as F from '../../core/chat/claudeFixtures'
import type { ProcLike } from '../../core/sessions/proc'
import type { ChatEvent } from '../../core/chat/types'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../../core/sessions/pty'

function fakeProc(): ProcLike & { written: string[]; feed(line: string): void; exit(code: number): void; notes: Record<string, unknown>[]; outlivesApp?: boolean } {
  let onLine: (l: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  const p = {
    pid: 42, written: [] as string[], notes: [] as Record<string, unknown>[], outlivesApp: undefined as boolean | undefined,
    onLine: (cb: (l: string) => void) => { onLine = cb },
    onExit: (cb: (e: { exitCode: number }) => void) => { onExit = cb },
    write: (line: string) => { p.written.push(line) },
    kill: vi.fn(),
    remember: (patch: Record<string, unknown>) => { p.notes.push(patch) },
    feed: (line: string) => onLine(line),
    exit: (code: number) => onExit({ exitCode: code })
  }
  return p
}

const SESSION_ID = '04c490a7-0ab2-419a-8c55-fdb8aea99ae0'
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

interface Wrote { type: string; request_id?: string; request?: Record<string, unknown>; response?: Record<string, unknown> }
const wrote = (p: { written: string[] }): Wrote[] => p.written.map((w) => JSON.parse(w) as Wrote)
const lastWrote = (p: { written: string[] }): Wrote => JSON.parse(p.written.at(-1) as string) as Wrote
/** The id the adapter actually used for its last control_request of that subtype — the replies below all
 *  have to name it, since every id carries the instance's own random prefix. */
const idOf = (p: { written: string[] }, subtype: string): string => {
  const sent = wrote(p).filter((w) => w.type === 'control_request' && w.request?.subtype === subtype).at(-1)
  if (!sent?.request_id) throw new Error(`no control_request ${subtype}`)
  return sent.request_id
}
const okReply = (p: { written: string[] }, subtype: string, response: Record<string, unknown>): string =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: idOf(p, subtype), response } })
/** One recorded control_response, mirrored onto the id the adapter used. */
const replyWith = (p: { written: string[] }, subtype: string, recorded: string): string =>
  okReply(p, subtype, (JSON.parse(recorded) as { response: { response: Record<string, unknown> } }).response.response)
const errReply = (p: { written: string[] }, subtype: string, error: string): string =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: idOf(p, subtype), error } })

function fresh(): { p: ReturnType<typeof fakeProc>; a: ReturnType<typeof createClaudeAdapter>; events: ChatEvent[] } {
  const p = fakeProc()
  const a = createClaudeAdapter({ proc: p, mode: { mode: 'fresh' }, version: '1.3.23', log: () => {}, requestTimeoutMs: 30_000 })
  const events: ChatEvent[] = []
  a.on((e) => events.push(e))
  return { p, a, events }
}

async function started(): Promise<{ p: ReturnType<typeof fakeProc>; a: ReturnType<typeof createClaudeAdapter>; events: ChatEvent[] }> {
  const { p, a, events } = fresh()
  const starting = a.start({ cwd: 'D:/x', bypass: false })
  await tick()
  p.feed(replyWith(p, 'initialize', F.INITIALIZE_RESPONSE))
  await starting
  return { p, a, events }
}

describe('createClaudeAdapter — handshake', () => {
  it('initializes, caches the model list and the permission mode, and waits for the first turn to know the session', async () => {
    const { p, a, events } = await started()
    expect(wrote(p).map((w) => w.request?.subtype)).toEqual(['initialize'])
    expect(lastWrote(p)).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } })
    // The catalogue came with the handshake, so the picker never asks again.
    expect((await a.listModels()).length).toBe(5)
    expect(wrote(p).map((w) => w.request?.subtype)).toEqual(['initialize'])
    expect(a.state().status).toBe('idle')
    expect(a.state().model).toEqual({ model: null, effort: null, planMode: false })
    // A fresh session has no id until its first turn's system/init — nothing to be ready with yet.
    expect(events.filter((e) => e.type === 'ready')).toEqual([])
  })

  it('a resumed session is ready at once with the id it was asked to resume, and notes it', async () => {
    const { p, a, events } = fresh()
    const starting = a.start({ cwd: 'D:/x', bypass: true, resumeThreadId: SESSION_ID })
    await tick()
    p.feed(replyWith(p, 'initialize', F.INITIALIZE_RESPONSE))
    await starting
    expect(events[0]).toEqual({ type: 'ready', threadId: SESSION_ID, rolloutPath: null })
    expect(p.notes[0]).toEqual({ threadId: SESSION_ID })
  })

  it('a refused initialize ends the session with the message', async () => {
    const { p, a, events } = fresh()
    const starting = a.start({ cwd: 'D:/x', bypass: false })
    await tick()
    p.feed(errReply(p, 'initialize', 'unknown option --output-format'))
    await expect(starting).rejects.toThrow('unknown option')
    expect(events).toContainEqual({ type: 'error', message: 'unknown option --output-format' })
    expect(p.kill).toHaveBeenCalled()
  })

  it('state() hands out a copy of the model, so a caller cannot write into the session', async () => {
    const { p, a } = await started()
    p.feed(F.SYSTEM_INIT)
    await tick()
    const first = a.state()
    first.model.model = 'tampered'
    expect(a.state().model.model).toBe('claude-fable-5-1')
  })
})

describe('createClaudeAdapter — a turn with a question', () => {
  it('sends the user frame, becomes ready at the first init, shows the question, answers it and comes back to idle', async () => {
    const { p, a, events } = await started()
    void a.send('ask me')
    await tick()
    expect(lastWrote(p)).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ask me' }] }, parent_tool_use_id: null })
    expect(a.state().status).toBe('working')

    p.feed(F.SYSTEM_INIT)
    await tick()
    expect(events).toContainEqual({ type: 'ready', threadId: SESSION_ID, rolloutPath: null })
    expect(p.notes[0]).toEqual({ threadId: SESSION_ID })
    expect(a.state().model).toEqual({ model: 'claude-fable-5-1', effort: null, planMode: false })
    expect(a.state().status).toBe('working')

    p.feed(F.ASSISTANT_ASK_TOOL_USE)
    p.feed(F.CAN_USE_TOOL_ASK)
    await tick()
    expect(a.state()).toMatchObject({ status: 'waiting', request: { id: '61631f85-69f4-404a-b464-da9956967ec5', kind: 'question' } })

    await a.answer('61631f85-69f4-404a-b464-da9956967ec5', { kind: 'question', answers: [{ picks: [1], other: '' }, { picks: [0, 1], other: '' }] })
    const sent = JSON.parse(p.written.at(-1) as string) as { response: { request_id: string; response: { behavior: string; updatedInput: { answers: Record<string, string> } } } }
    expect(sent.response.request_id).toBe('61631f85-69f4-404a-b464-da9956967ec5')
    expect(sent.response.response.behavior).toBe('allow')
    // The shape the recorded run's tool_result echoed back, to the letter.
    expect(sent.response.response.updatedInput.answers).toEqual((JSON.parse(F.USER_ECHO_ASK_RESULT) as { tool_use_result: { answers: Record<string, string> } }).tool_use_result.answers)
    await tick()
    expect(a.state()).toMatchObject({ status: 'working', request: null })

    p.feed(F.USER_ECHO_ASK_RESULT)
    await tick()
    expect(a.state()).toMatchObject({ status: 'working', request: null })
    p.feed(F.RESULT_SUCCESS_ASK)
    await tick()
    expect(a.state().status).toBe('idle')
    expect(a.state().error).toBeNull()
    expect(events.filter((e) => e.type === 'request').length).toBe(2) // shown once, cleared once
  })

  it('shows an approval with the session decision, writes the deny frame, and a denied turn is not a failure', async () => {
    const { p, a } = await started()
    void a.send('write a file')
    await tick()
    p.feed(F.SYSTEM_INIT)
    p.feed(F.CAN_USE_TOOL_WRITE)
    await tick()
    expect(a.state()).toMatchObject({
      status: 'waiting',
      request: { id: 'e2c6575b-58ee-471f-9814-b42385019f90', kind: 'approval', decisions: ['accept', 'acceptForSession', 'decline'] }
    })
    await a.answer('e2c6575b-58ee-471f-9814-b42385019f90', { kind: 'approval', decision: 'decline' })
    expect(lastWrote(p)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'e2c6575b-58ee-471f-9814-b42385019f90', response: { behavior: 'deny', message: 'User declined in Astera' } }
    })
    await tick()
    expect(a.state()).toMatchObject({ status: 'working', request: null })
    p.feed(F.USER_ECHO_WRITE_DENIED)
    p.feed(F.RESULT_WITH_DENIALS)
    await tick()
    expect(a.state()).toMatchObject({ status: 'idle', request: null, error: null })
  })

  it('answering an id that is not open is an error, and an unsupported control_request is refused on the wire', async () => {
    const { p, a, events } = await started()
    await expect(a.answer('nope', { kind: 'approval', decision: 'accept' })).rejects.toThrow()
    p.feed(JSON.stringify({ type: 'control_request', request_id: 'x1', request: { subtype: 'request_user_dialog' } }))
    await tick()
    expect(lastWrote(p)).toEqual({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'x1', error: 'unsupported request: request_user_dialog' }
    })
    expect(events).toContainEqual({ type: 'error', message: 'unsupported request: request_user_dialog' })
    expect(a.state().request).toBeNull()
    // Remembered, not only announced — a pane that mounts after this moment reads state.error.
    expect(a.state().error).toContain('unsupported request')
  })

  it('interrupts the running turn, and the aborted result is idle without an error', async () => {
    const { p, a } = await started()
    void a.send('count')
    await tick()
    p.feed(F.SYSTEM_INIT)
    await tick()
    const stopping = a.interrupt()
    await tick()
    expect(lastWrote(p)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } })
    p.feed(replyWith(p, 'interrupt', F.INTERRUPT_RESPONSE))
    await expect(stopping).resolves.toBeUndefined()
    p.feed(F.RESULT_ABORTED)
    await tick()
    expect(a.state().status).toBe('idle')
    expect(a.state().error).toBeNull()
  })

  it('an interrupt the CLI refuses is a no-op, but one that never gets an answer still rejects', async () => {
    const { p, a } = await started()
    const refused = a.interrupt()
    await tick()
    p.feed(errReply(p, 'interrupt', 'No conversation in progress'))
    await expect(refused).resolves.toBeUndefined()
    p.exit(0)
    await expect(a.interrupt()).rejects.toThrow('process ended')
  })

  it('a turn written after the process is gone is refused at once', async () => {
    const { p, a } = await started()
    p.exit(0)
    await expect(a.send('x')).rejects.toThrow('process ended')
  })

  it('a new turn clears the last turn’s failure', async () => {
    const { p, a } = await started()
    void a.send('do it')
    await tick()
    p.feed(F.SYSTEM_INIT)
    p.feed(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, terminal_reason: 'completed', session_id: SESSION_ID }))
    await tick()
    expect(a.state()).toMatchObject({ status: 'idle', error: 'error_max_turns' })
    void a.send('try again')
    await tick()
    expect(a.state()).toMatchObject({ status: 'working', error: null })
  })

  it('a request that arrives before the first init still counts as a running turn', async () => {
    const { p, a } = await started()
    void a.send('write a file')
    await tick()
    p.feed(F.CAN_USE_TOOL_WRITE) // no system/init yet: the session id is still unknown
    await tick()
    expect(a.state().status).toBe('waiting')
    p.feed(F.USER_ECHO_WRITE_DENIED) // the CLI resolved the prompt itself, and the turn carries on
    await tick()
    // 'working', not 'idle' — the provisional turn marker send() set is what tells the two apart.
    expect(a.state()).toMatchObject({ status: 'working', request: null })
  })
})

describe('createClaudeAdapter — the model and the permission mode', () => {
  it('sets the permission mode and the status message that follows agrees', async () => {
    const { p, a } = await started()
    const planning = a.setPlanMode(true)
    await tick()
    expect(lastWrote(p)).toMatchObject({ type: 'control_request', request: { subtype: 'set_permission_mode', mode: 'plan' } })
    p.feed(replyWith(p, 'set_permission_mode', F.SET_MODE_RESPONSE))
    await planning
    expect(a.state().model.planMode).toBe(true)
    p.feed(F.SYSTEM_STATUS_PLAN)
    await tick()
    expect(a.state().model.planMode).toBe(true)
  })

  it('sets the model on acknowledgement, and leaves the effort alone — this build has no request for it', async () => {
    const { p, a } = await started()
    const picking = a.setModel('sonnet', 'high')
    await tick()
    expect(lastWrote(p)).toMatchObject({ type: 'control_request', request: { subtype: 'set_model', model: 'sonnet' } })
    p.feed(okReply(p, 'set_model', {}))
    await picking
    expect(a.state().model).toEqual({ model: 'sonnet', effort: null, planMode: false })
  })

  it('a later init keeps an effort it does not carry and follows the permission mode it does', async () => {
    const { p, a } = await started()
    const init = JSON.parse(F.SYSTEM_INIT) as Record<string, unknown>
    p.feed(JSON.stringify({ ...init, effort: 'high', permissionMode: 'plan' }))
    await tick()
    expect(a.state().model).toEqual({ model: 'claude-fable-5-1', effort: 'high', planMode: true })
    // The next turn's init: same session, no effort field at all, and the mode back to default.
    p.feed(F.SYSTEM_INIT)
    await tick()
    expect(a.state().model).toEqual({ model: 'claude-fable-5-1', effort: 'high', planMode: false })
  })
})

describe('createClaudeAdapter — replay after adoption', () => {
  function adopted(truncated = false): { p: ReturnType<typeof fakeProc>; a: ReturnType<typeof createClaudeAdapter>; events: ChatEvent[] } {
    const p = fakeProc()
    const a = createClaudeAdapter({ proc: p, mode: { mode: 'adopt', threadId: SESSION_ID, rolloutPath: null, truncated }, version: '1', log: () => {}, requestTimeoutMs: 30_000 })
    const events: ChatEvent[] = []
    a.on((e) => events.push(e))
    return { p, a, events }
  }

  it('speaks no handshake and is ready with the adopted session at once', async () => {
    const { p, a, events } = adopted()
    await a.start({ cwd: 'D:/x', bypass: false })
    expect(p.written).toEqual([])
    expect(events[0]).toEqual({ type: 'ready', threadId: SESSION_ID, rolloutPath: null })
  })

  it('a request answered before the restart is not shown — its tool_result echo follows it', async () => {
    const { p, a, events } = adopted()
    await a.start({ cwd: 'D:/x', bypass: false })
    for (const l of [F.SYSTEM_INIT, F.CAN_USE_TOOL_ASK, F.USER_ECHO_ASK_RESULT, F.RESULT_SUCCESS_ASK]) p.feed(l)
    await tick()
    expect(a.state()).toMatchObject({ status: 'idle', request: null })
    expect(events.filter((e) => e.type === 'request')).toEqual([])
  })

  it('a request the finished turn left behind is not shown either — the CLI does not keep one across a result', async () => {
    const { p, a, events } = adopted()
    await a.start({ cwd: 'D:/x', bypass: false })
    for (const l of [F.SYSTEM_INIT, F.CAN_USE_TOOL_WRITE, F.RESULT_WITH_DENIALS]) p.feed(l)
    await tick()
    expect(a.state()).toMatchObject({ status: 'idle', request: null })
    expect(events.filter((e) => e.type === 'request')).toEqual([])
  })

  it('a request that was still open when the app died is shown, and can be answered', async () => {
    const { p, a } = adopted()
    await a.start({ cwd: 'D:/x', bypass: false })
    p.feed(F.SYSTEM_INIT)
    p.feed(F.CAN_USE_TOOL_WRITE)
    await tick()
    expect(a.state()).toMatchObject({ status: 'waiting', request: { id: 'e2c6575b-58ee-471f-9814-b42385019f90', kind: 'approval' } })
    await a.answer('e2c6575b-58ee-471f-9814-b42385019f90', { kind: 'approval', decision: 'acceptForSession' })
    const sent = JSON.parse(p.written.at(-1) as string) as { response: { response: { updatedPermissions: unknown[] } } }
    expect(sent.response.response.updatedPermissions).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
  })

  it('the first frame that is definite about the turn clears truncated, and says so on the status event', async () => {
    const { p, a, events } = adopted(true)
    await a.start({ cwd: 'D:/x', bypass: false })
    expect(a.state().truncated).toBe(true)
    p.feed(F.SYSTEM_INIT)
    await tick()
    expect(a.state().truncated).toBe(false)
    expect(events).toContainEqual({ type: 'status', status: 'working', truncated: false })
  })

  it('an adopted session with no cached catalogue asks for the models once', async () => {
    const { p, a } = adopted()
    await a.start({ cwd: 'D:/x', bypass: false })
    const listing = a.listModels()
    await tick()
    expect(lastWrote(p)).toMatchObject({ type: 'control_request', request: { subtype: 'list_models' } })
    p.feed(replyWith(p, 'list_models', F.LIST_MODELS_RESPONSE))
    expect((await listing).map((m) => m.id)).toEqual(['default', 'opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku'])
  })

  it('reads outlivesApp live from the process, not from a snapshot taken at start', async () => {
    const { p, a } = adopted()
    p.outlivesApp = true
    await a.start({ cwd: 'D:/x', bypass: false })
    expect(a.state().outlivesApp).toBe(true)
  })

  it('exit ends pending requests and is reported with its code', async () => {
    const { p, a, events } = await started()
    const listing = a.setModel('sonnet', null)
    await tick()
    p.exit(PTY_LOST_SIGHT_EXIT_CODE)
    await expect(listing).rejects.toThrow()
    expect(events.at(-1)).toEqual({ type: 'exit', code: PTY_LOST_SIGHT_EXIT_CODE })
  })
})
