import { describe, it, expect, vi } from 'vitest'
import { createCodexAdapter } from './codexAdapter'
import * as F from '../../core/chat/codexFixtures'
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
/** The last request the adapter wrote, parsed, and a reply builder that mirrors its id. */
const lastReq = (p: { written: string[] }) => JSON.parse(p.written.at(-1) as string) as { id: string; method: string; params: Record<string, unknown> }
const replyWith = (p: { written: string[] }, method: string, resultLine: string) => {
  const r = p.written.map((w) => JSON.parse(w) as { id?: string; method?: string }).filter((w) => w.method === method && w.id !== undefined).at(-1)
  if (!r) throw new Error(`no request ${method}`)
  const body = JSON.parse(resultLine) as { result: unknown }
  return JSON.stringify({ id: r.id, result: body.result })
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

async function started(): Promise<{ p: ReturnType<typeof fakeProc>; a: ReturnType<typeof createCodexAdapter>; events: ChatEvent[] }> {
  const p = fakeProc()
  const a = createCodexAdapter({ proc: p, mode: { mode: 'fresh' }, version: '1.3.23', log: () => {}, requestTimeoutMs: 1000 })
  const events: ChatEvent[] = []
  a.on((e) => events.push(e))
  const starting = a.start({ cwd: 'D:/x', bypass: false })
  await tick()
  p.feed(replyWith(p, 'initialize', F.INITIALIZE_RESULT))
  await tick()
  p.feed(replyWith(p, 'collaborationMode/list', F.COLLAB_MODES_RESULT))
  p.feed(replyWith(p, 'model/list', F.MODEL_LIST_RESULT))
  await tick()
  p.feed(replyWith(p, 'thread/start', F.THREAD_START_RESULT))
  await starting
  return { p, a, events }
}

describe('createCodexAdapter — handshake', () => {
  it('initializes with the experimental API, lists modes and models, starts the thread, reports ready and notes the thread', async () => {
    const { p, a, events } = await started()
    const methods = p.written.map((w) => JSON.parse(w).method)
    expect(methods).toEqual(['initialize', 'initialized', 'collaborationMode/list', 'model/list', 'thread/start'])
    expect(JSON.parse(p.written[0]).params.capabilities.experimentalApi).toBe(true)
    expect(JSON.parse(p.written[4]).params).toEqual({ cwd: 'D:/x', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(events[0]).toMatchObject({ type: 'ready', threadId: '01a0a6cb-43a2-7d71-994f-72e53764fbc1' })
    expect(p.notes[0]).toMatchObject({ threadId: '01a0a6cb-43a2-7d71-994f-72e53764fbc1' })
    expect((await a.listModels()).length).toBe(5)
    expect(a.state().status).toBe('idle')
  })
  it('resumes instead of starting when given a thread id, without the history', async () => {
    const p = fakeProc()
    const a = createCodexAdapter({ proc: p, mode: { mode: 'fresh' }, version: '1', log: () => {}, requestTimeoutMs: 1000 })
    const starting = a.start({ cwd: 'D:/x', bypass: true, resumeThreadId: '01a0a6cd-7f52-7690-a1ae-d7c9cb688c35' })
    await tick(); p.feed(replyWith(p, 'initialize', F.INITIALIZE_RESULT)); await tick()
    p.feed(replyWith(p, 'collaborationMode/list', F.COLLAB_MODES_RESULT)); p.feed(replyWith(p, 'model/list', F.MODEL_LIST_RESULT)); await tick()
    expect(lastReq(p)).toMatchObject({ method: 'thread/resume', params: { threadId: '01a0a6cd-7f52-7690-a1ae-d7c9cb688c35', excludeTurns: true, approvalPolicy: 'never', sandbox: 'danger-full-access' } })
    p.feed(replyWith(p, 'thread/resume', F.THREAD_RESUME_RESULT))
    await starting
    expect(a.state().status).toBe('idle')
  })
  it('a refused collaborationMode/list is not fatal — start still resolves, and plan mode sends without an effort', async () => {
    const p = fakeProc()
    const a = createCodexAdapter({ proc: p, mode: { mode: 'fresh' }, version: '1', log: () => {}, requestTimeoutMs: 1000 })
    const events: ChatEvent[] = []
    a.on((e) => events.push(e))
    const starting = a.start({ cwd: 'D:/x', bypass: false })
    await tick()
    p.feed(replyWith(p, 'initialize', F.INITIALIZE_RESULT))
    await tick()
    const collabReq = p.written.map((w) => JSON.parse(w) as { id?: string; method?: string }).find((w) => w.method === 'collaborationMode/list')
    if (!collabReq) throw new Error('no request collaborationMode/list')
    p.feed(JSON.stringify({ id: collabReq.id, error: { code: -32600, message: 'unknown method' } }))
    p.feed(replyWith(p, 'model/list', F.MODEL_LIST_RESULT))
    await tick()
    p.feed(replyWith(p, 'thread/start', F.THREAD_START_RESULT))
    await starting
    expect(events[0]).toMatchObject({ type: 'ready' })
    await a.setPlanMode(true)
    void a.send('ask me')
    await tick()
    expect(JSON.parse(p.written.at(-1) as string).params.collaborationMode).toEqual({ mode: 'plan', settings: { model: 'gpt-6-astra' } })
  })
  it('a refused initialize ends the session with the message', async () => {
    const p = fakeProc()
    const a = createCodexAdapter({ proc: p, mode: { mode: 'fresh' }, version: '1', log: () => {}, requestTimeoutMs: 1000 })
    const events: ChatEvent[] = []
    a.on((e) => events.push(e))
    const starting = a.start({ cwd: 'D:/x', bypass: false })
    await tick()
    p.feed(JSON.stringify({ id: lastReq(p).id, error: { code: -32600, message: 'too old' } }))
    await expect(starting).rejects.toThrow('too old')
    expect(events).toContainEqual({ type: 'error', message: 'too old' })
    expect(p.kill).toHaveBeenCalled()
  })
})

describe('createCodexAdapter — a turn with a question', () => {
  it('sends the plan struct, shows the question, answers it by id, and comes back to idle', async () => {
    const { p, a, events } = await started()
    await a.setPlanMode(true)
    void a.send('ask me')
    await tick()
    expect(lastReq(p)).toMatchObject({ method: 'turn/start', params: { collaborationMode: { mode: 'plan', settings: { model: 'gpt-6-astra', reasoning_effort: 'medium' } } } })
    p.feed(F.TURN_STARTED)
    p.feed(F.THREAD_SETTINGS_UPDATED_PLAN)
    p.feed(F.REQUEST_USER_INPUT)
    await tick()
    const s = a.state()
    expect(s.status).toBe('waiting')
    expect(s.request).toMatchObject({ id: '0', kind: 'question' })
    expect(s.model).toEqual({ model: 'gpt-6-astra', effort: 'medium', planMode: true })
    if (s.request?.kind !== 'question') throw new Error()
    await a.answer('0', { kind: 'question', answers: [{ picks: [1], other: '' }, { picks: [1], other: '' }] })
    expect(JSON.parse(p.written.at(-1) as string)).toEqual({ id: 0, result: { answers: { format: { answers: ['Detailed'] }, sections: { answers: ['Methods'] } } } })
    await tick()
    expect(a.state()).toMatchObject({ status: 'working', request: null })
    p.feed(F.SERVER_REQUEST_RESOLVED)
    p.feed(F.TURN_COMPLETED_OK)
    await tick()
    expect(a.state().status).toBe('idle')
    expect(events.filter((e) => e.type === 'request').length).toBe(2)   // shown once, cleared once
  })
  it('answering an id that is not open is an error, and an unknown server request is refused on the wire', async () => {
    const { p, a, events } = await started()
    await expect(a.answer('99', { kind: 'approval', decision: 'accept' })).rejects.toThrow()
    p.feed(JSON.stringify({ id: 5, method: 'item/permissions/requestApproval', params: {} }))
    await tick()
    expect(JSON.parse(p.written.at(-1) as string)).toEqual({ id: 5, error: { code: -32601, message: 'unsupported request: item/permissions/requestApproval' } })
    expect(events).toContainEqual({ type: 'error', message: 'unsupported request: item/permissions/requestApproval' })
    expect(a.state().request).toBeNull()
  })
  it('a subscriber that answers synchronously inside the request event still sees the clearing event', async () => {
    const { p, a, events } = await started()
    a.on((e) => {
      if (e.type === 'request' && e.request) void a.answer(e.request.id, { kind: 'approval', decision: 'accept' })
    })
    void a.send('do it')
    await tick()
    p.feed(F.TURN_STARTED)
    p.feed(F.COMMAND_APPROVAL)
    await tick()
    await tick()
    const requestEvents = events.filter((e): e is Extract<ChatEvent, { type: 'request' }> => e.type === 'request')
    expect(requestEvents.some((e) => e.request?.kind === 'approval')).toBe(true)
    expect(requestEvents.some((e) => e.request === null)).toBe(true)
  })
  it('interrupt asks for the running turn and is a no-op without one', async () => {
    const { p, a } = await started()
    const before = p.written.length
    await a.interrupt()
    expect(p.written.length).toBe(before)
    void a.send('count')
    await tick()
    p.feed(F.TURN_STARTED)
    void a.interrupt()
    await tick()
    expect(lastReq(p)).toMatchObject({ method: 'turn/interrupt', params: { turnId: '01a0a6cb-446f-7121-b8cb-970a1d5e35d5' } })
    p.feed(F.TURN_COMPLETED_INTERRUPTED)
    await tick()
    expect(a.state().status).toBe('idle')
  })
})

describe('createCodexAdapter — replay after adoption', () => {
  function adopted(truncated = false) {
    const p = fakeProc()
    const a = createCodexAdapter({ proc: p, mode: { mode: 'adopt', threadId: '01a0a6cb-43a2-7d71-994f-72e53764fbc1', rolloutPath: null, truncated }, version: '1', log: () => {}, requestTimeoutMs: 1000 })
    const events: ChatEvent[] = []
    a.on((e) => events.push(e))
    return { p, a, events }
  }
  it('a request that was answered before the restart is not shown — serverRequest/resolved follows it', async () => {
    const { p, a, events } = adopted()
    await a.start({ cwd: 'D:/x', bypass: false })
    expect(p.written).toEqual([])   // no handshake on adoption
    for (const l of [F.TURN_STARTED, F.REQUEST_USER_INPUT, F.SERVER_REQUEST_RESOLVED, F.TURN_COMPLETED_OK]) p.feed(l)
    await tick()
    expect(a.state()).toMatchObject({ status: 'idle', request: null })
    expect(events.filter((e) => e.type === 'request')).toEqual([])
  })
  it('a request that was still open when the app died is shown, and a replayed turn without its end is working', async () => {
    const { p, a } = adopted()
    await a.start({ cwd: 'D:/x', bypass: false })
    p.feed(F.TURN_STARTED); p.feed(F.COMMAND_APPROVAL)
    await tick()
    expect(a.state()).toMatchObject({ status: 'waiting', request: { kind: 'approval', id: '0' } })
    await a.answer('0', { kind: 'approval', decision: 'decline' })
    expect(JSON.parse(p.written.at(-1) as string)).toEqual({ id: 0, result: { decision: 'decline' } })
  })
  it('a reply to an earlier app instance’s request is dropped, and truncated is carried into the state', async () => {
    const { p, a } = adopted(true)
    await a.start({ cwd: 'D:/x', bypass: false })
    p.feed(JSON.stringify({ id: 'a12345678-3', result: { turn: { id: 'ghost' } } }))
    await tick()
    expect(a.state().truncated).toBe(true)
    expect(a.state().status).toBe('idle')
  })
  it('reads outlivesApp live from the process, not from a snapshot taken at start', async () => {
    const { p, a } = adopted()
    p.outlivesApp = true
    await a.start({ cwd: 'D:/x', bypass: false })
    expect(a.state().outlivesApp).toBe(true)
  })
  it('exit ends pending requests and is reported with its code', async () => {
    const { p, a, events } = await started()
    const sending = a.send('x')
    await tick()
    p.exit(PTY_LOST_SIGHT_EXIT_CODE)
    await expect(sending).rejects.toThrow()
    expect(events.at(-1)).toEqual({ type: 'exit', code: PTY_LOST_SIGHT_EXIT_CODE })
  })
})
