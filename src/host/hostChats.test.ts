import { describe, it, expect, vi } from 'vitest'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { createProcHolders } from './procHolders'
import { createHostChats, CHAT_START_PUSH_MS } from './hostChats'
import { CHAT_REQUEST_TIMEOUT_MS } from '../core/chat/adapterCore'
import * as F from '../core/chat/claudeFixtures'
import type { Account } from '../core/types'
import type { ChatEvent } from '../core/chat/types'

const account: Account = { id: 'a1', label: 'a1', configDir: 'C:\\c1', color: '#fff', createdAt: '2026-09-26T00:00:00Z' }
function fake(): RegistryProc & { sent: string[]; emit(c: string): void } {
  let onData: (c: string) => void = () => {}
  const p = { pid: 9, sent: [] as string[], onData: (cb: typeof onData) => { onData = cb }, onExit: () => {}, write: (d: string) => { p.sent.push(d) }, kill: () => {}, emit: (c: string) => onData(c) }
  return p
}
const note = (over: Record<string, unknown> = {}) => ({ kind: 'chat' as const, id: 'c1', restore: { accountId: 'a1', cwd: 'D:/p', title: 't', provider: 'claude', threadId: 'th', unattendedPermission: 'hold', ...over } })

type CreateAdapter = NonNullable<Parameters<typeof createHostChats>[0]['createAdapter']>
/** An adapter that does nothing on its own, for a test that drives its start and send by hand. */
const stubAdapter = (over: Partial<ReturnType<CreateAdapter>> = {}): ReturnType<CreateAdapter> => ({
  start: async () => {},
  send: async () => {},
  interrupt: async () => {},
  answer: async () => {},
  setModel: async () => {},
  setPermissionMode: async () => {},
  listPermissionModes: async () => [],
  listModels: async () => [],
  state: () => ({ status: 'idle', request: null, model: { model: null, effort: null, permissionMode: 'default' }, error: null, exitCode: null, errorDetail: null, outlivesApp: true, truncated: false, provider: 'claude' }),
  pending: () => [],
  on: () => () => {},
  kill: () => {},
  ...over
})

const rig = (restore: Record<string, unknown> = {}, createAdapter?: CreateAdapter) => {
  const procs: ReturnType<typeof fake>[] = []
  const registry = new ProcRegistry({ spawn: () => { const p = fake(); procs.push(p); return p }, log: () => {} })
  registry.open({ id: 'p1', file: 'claude', args: [], opts: { cwd: 'D:/p', env: {} }, meta: note(restore) })
  const holders = createProcHolders()
  const askApp = vi.fn(async () => ({ sent: true }))
  const logs: string[] = []
  const chats = createHostChats({ procs: registry, holders, platform: 'win32', homeDir: 'C:\\Users\\t', version: '0.0.0', baseEnv: {}, askApp, log: (m) => logs.push(m), ...(createAdapter ? { createAdapter } : {}) })
  return { registry, procs, holders, chats, askApp, logs, entry: () => registry.list()[0] }
}

describe('createHostChats — the writer rule (spec §3.2)', () => {
  it('is the writer of an adopted proc no socket holds, and a reader once an app holds it', () => {
    const r = rig()
    expect(r.chats.adopt(r.entry())?.id).toBe('c1')
    expect(r.chats.isWriter('c1')).toBe(true)
    r.holders.heldBy('p1', 1)
    expect(r.chats.isWriter('c1')).toBe(false)
    r.holders.appGone(1)
    expect(r.chats.isWriter('c1')).toBe(true)
  })

  it('tells a writer change', () => {
    const r = rig()
    r.chats.adopt(r.entry())
    let n = 0
    r.chats.onWriterChange(() => n++)
    r.holders.heldBy('p1', 1)
    r.holders.appGone(1)
    expect(n).toBe(2)
  })

  it('a turn goes through the Host adapter while it writes, and to the app chatSend while the app does', async () => {
    const r = rig()
    r.chats.adopt(r.entry())
    r.chats.deliver('c1', 'first')
    r.holders.heldBy('p1', 1)
    r.chats.deliver('c1', 'second')
    await vi.waitFor(() => expect(r.askApp).toHaveBeenCalledWith('chatSend', ['c1', 'second']))
    expect(r.procs[0].sent.join('')).toContain('"text":"first"')
    expect(r.procs[0].sent.join('')).not.toContain('"text":"second"')
  })

  it('sees a prompt from the replay, lists it while it writes, and not while the app does', () => {
    const r = rig()
    r.procs[0].emit(`${F.CAN_USE_TOOL_WRITE}\n`)
    r.chats.adopt(r.entry())
    expect(r.chats.prompts().map((p) => p.sessionId)).toEqual(['c1'])
    expect(r.chats.hasOpenRequest('c1')).toBe(true)
    r.holders.heldBy('p1', 1)
    expect(r.chats.prompts()).toEqual([])
    expect(r.chats.hasOpenRequest('c1')).toBe(true)
  })

  it('leaves out a prompt the note lists as answered', () => {
    const id = (JSON.parse(F.CAN_USE_TOOL_WRITE) as { request_id: string }).request_id
    const r = rig({ answered: [id] })
    r.procs[0].emit(`${F.CAN_USE_TOOL_WRITE}\n`)
    r.chats.adopt(r.entry())
    expect(r.chats.prompts()).toEqual([])
  })

  it('answers an open approval, 409-shaped for a closed one and for a question', async () => {
    const r = rig()
    r.procs[0].emit(`${F.CAN_USE_TOOL_WRITE}\n${F.CAN_USE_TOOL_ASK}\n`)
    r.chats.adopt(r.entry())
    const [write, ask] = r.chats.prompts()
    expect(await r.chats.answer('c1', ask.id, 'deny')).toEqual({ answered: false, reason: 'question' })
    const mark = vi.fn()
    expect(await r.chats.answer('c1', write.id, 'deny', mark)).toEqual({ answered: true })
    expect(mark).toHaveBeenCalledTimes(1)
    expect(await r.chats.answer('c1', write.id, 'deny')).toEqual({ answered: false, reason: 'not-open' })
    expect(await r.chats.answer('nope', write.id, 'allow')).toEqual({ answered: false, reason: 'not-held' })
  })

  // Task 8 fix round 1 (D4 I1): a send the adapter could not put on the wire leaves no receipt.
  it('a send that throws before any line reached the proc never calls its mark', async () => {
    const r = rig()
    r.chats.adopt(r.entry())
    r.procs[0].write = () => {
      throw new Error('EPIPE')
    }
    const mark = vi.fn()
    await expect(r.chats.send('c1', 'hi', mark)).rejects.toThrow()
    expect(mark).not.toHaveBeenCalled()
  })

  it('a send that reached the proc calls its mark once', async () => {
    const r = rig()
    r.chats.adopt(r.entry())
    const mark = vi.fn()
    await r.chats.send('c1', 'hi', mark).catch(() => {})
    expect(r.procs[0].sent.join('')).toContain('"text":"hi"')
    expect(mark).toHaveBeenCalledTimes(1)
  })

  // Task 8 fix round 1 (Minor 1): the same rule for an answer, and a failure that is not "no open
  // request" means this side could not answer (not-held), not that the prompt closed.
  it('an answer whose write throws is not-held and never calls its mark', async () => {
    const r = rig()
    r.procs[0].emit(`${F.CAN_USE_TOOL_WRITE}\n`)
    r.chats.adopt(r.entry())
    const [write] = r.chats.prompts()
    r.procs[0].write = () => {
      throw new Error('EPIPE')
    }
    const mark = vi.fn()
    expect(await r.chats.answer('c1', write.id, 'allow', mark)).toEqual({ answered: false, reason: 'not-held' })
    expect(mark).not.toHaveBeenCalled()
    expect(r.chats.prompts().map((p) => p.id)).toEqual([write.id])
  })

  it('spawns a roll respawn marked hostStarting, and clears the mark once started', async () => {
    const r = rig()
    const info = r.chats.spawn({ account, cwd: 'D:/p', resumeSessionId: 'th', restoreExtra: { rolledFrom: 'c1' } })
    const e = r.registry.list().find((x) => x.meta?.id === info.id)!
    expect(e.meta?.restore).toMatchObject({ hostStarting: true, rolledFrom: 'c1', rolledBy: 'host' })
    r.procs[1].emit(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: JSON.parse(r.procs[1].sent[0]).request_id, response: {} } })}\n`)
    await r.chats.started(info.id)
    expect(r.registry.list().find((x) => x.meta?.id === info.id)!.meta?.restore.hostStarting).toBeNull()
  })

  // Final review I1: a codex handshake is a chain of 30 s requests, so a slow machine can still be
  // starting well past 45 s. The mark stays and no push goes until the start has really settled, and
  // the carry-on the start sends goes out exactly once.
  it('waits for a handshake slower than 45 s, keeps hostStarting meanwhile, and sends its carry-on once', async () => {
    vi.useFakeTimers()
    try {
      let finish: () => void = () => {}
      const sent: string[] = []
      const r = rig({}, ({ proc }) =>
        stubAdapter({
          start: () => new Promise<void>((res) => { finish = res }),
          send: async (t) => { proc.write(t); sent.push(t) }
        })
      )
      const info = r.chats.spawn({ account, cwd: 'D:/p', initialPrompt: 'carry on' })
      const noteOf = () => r.registry.list().find((x) => x.meta?.id === info.id)!.meta!.restore
      let settled: boolean | undefined
      void r.chats.started(info.id).then((v) => { settled = v })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(settled).toBeUndefined()
      expect(noteOf().hostStarting).toBe(true)
      expect(sent).toEqual([])
      finish()
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
      expect(sent).toEqual(['carry on'])
      expect(noteOf()).toMatchObject({ hostStarting: null, carrySent: true })
      await vi.advanceTimersByTimeAsync(CHAT_START_PUSH_MS)
      expect(sent).toEqual(['carry on'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('the bound sits above the worst codex handshake: every request deadline in a row, with margin', () => {
    // initialize, the two lists, thread/resume and the carry-on's turn/start.
    expect(CHAT_START_PUSH_MS).toBeGreaterThan(5 * CHAT_REQUEST_TIMEOUT_MS)
  })

  it('a start that never settles within the bound is killed, not handed over: the mark stays, started() says false', async () => {
    vi.useFakeTimers()
    try {
      const killed: string[] = []
      const r = rig({}, () => stubAdapter({ start: () => new Promise<void>(() => {}), kill: () => { killed.push('kill') } }))
      const info = r.chats.spawn({ account, cwd: 'D:/p' })
      const s = r.chats.started(info.id)
      await vi.advanceTimersByTimeAsync(CHAT_START_PUSH_MS)
      await expect(s).resolves.toBe(false)
      expect(killed).toEqual(['kill'])
      expect(r.registry.list().find((x) => x.meta?.id === info.id)!.meta!.restore.hostStarting).toBe(true)
      expect(r.logs.join(' ')).toMatch(/did not settle/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createHostChats — a roll reads the note, not the copy taken at adopt (final review I2)', () => {
  // While the app is the writer, setModel and setUnattendedPermission reach only the note.
  it.each([
    ['hold', 'deny-after-60s'],
    ['deny-after-60s', 'hold']
  ])('rolls with the model and the policy the note has now (%s, then %s)', (was, now) => {
    const r = rig({ chosenModel: 'opus', unattendedPermission: was })
    r.chats.adopt(r.entry())
    r.registry.note('p1', { chosenModel: 'sonnet', unattendedPermission: now })
    expect(r.chats.chosenModelOf('c1')).toBe('sonnet')
    const info = r.chats.spawn({ account, cwd: 'D:/p', restoreExtra: { rolledFrom: 'c1' } })
    expect(r.registry.list().find((x) => x.meta?.id === info.id)!.meta!.restore.unattendedPermission).toBe(now)
  })

  it('falls back to the adopted pick when the note has none', () => {
    const r = rig({ chosenModel: 'opus' })
    r.chats.adopt(r.entry())
    r.registry.note('p1', { chosenModel: null })
    expect(r.chats.chosenModelOf('c1')).toBe('opus')
  })
})

describe('createHostChats — a dropped session hears nothing (Task 2 review carry)', () => {
  const heardRig = () => {
    const procs: ReturnType<typeof fake>[] = []
    const registry = new ProcRegistry({ spawn: () => { const p = fake(); procs.push(p); return p }, log: () => {} })
    registry.open({ id: 'p1', file: 'claude', args: [], opts: { cwd: 'D:/p', env: {} }, meta: note() })
    const heard: string[] = []
    const createAdapter: NonNullable<Parameters<typeof createHostChats>[0]['createAdapter']> = ({ proc }) => {
      proc.onLine((l) => heard.push(l))
      return {
        start: async () => {},
        send: async () => {},
        interrupt: async () => {},
        answer: async () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        listPermissionModes: async () => [],
        listModels: async () => [],
        state: () => ({ status: 'idle', request: null, model: { model: null, effort: null, permissionMode: 'default' }, error: null, exitCode: null, errorDetail: null, outlivesApp: true, truncated: false, provider: 'claude' }),
        pending: () => [],
        on: () => () => {},
        kill: () => {}
      }
    }
    const chats = createHostChats({ procs: registry, holders: createProcHolders(), platform: 'win32', homeDir: 'C:\\Users\\t', version: '0.0.0', baseEnv: {}, askApp: async () => ({ sent: true }), log: () => {}, createAdapter })
    chats.adopt(registry.list()[0])
    return { procs, chats, heard }
  }

  it('a forgotten session\'s adapter decodes no further lines', () => {
    const r = heardRig()
    r.procs[0].emit('a\n')
    r.chats.forget('c1')
    r.procs[0].emit('b\n')
    expect(r.heard).toEqual(['a'])
    expect(r.chats.has('c1')).toBe(false)
  })

  it('after dispose no adapter decodes a line', () => {
    const r = heardRig()
    r.chats.dispose()
    r.procs[0].emit('b\n')
    expect(r.heard).toEqual([])
  })
})

describe('createHostChats — the gate is the holders (Task 3 review)', () => {
  // Important 1. Mutation: hand createHostProcs `mayWrite: () => true`; this test must fail.
  it('a reader-role Host adapter writes nothing once an app holds the proc', () => {
    const r = rig()
    r.chats.adopt(r.entry())
    r.holders.heldBy('p1', 1)
    r.procs[0].emit('{"type":"control_request","request_id":"q1","request":{"subtype":"no_such_thing"}}\n')
    expect(r.procs[0].sent).toEqual([])
  })

  // Important 3. P4: the carry-on goes only through the writer. While the app holds the new proc, the
  // Host neither marks it sent nor writes it, so the real writer sends it later.
  it('leaves a carry-on unsent and unmarked while the Host is not the writer', async () => {
    const r = rig()
    const info = r.chats.spawn({ account, cwd: 'D:/p', initialPrompt: 'carry on' })
    const procId = r.chats.procOf(info.id)!
    r.holders.heldBy(procId, 1)
    r.procs[1].emit(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: JSON.parse(r.procs[1].sent[0]).request_id, response: {} } })}\n`)
    await r.chats.started(info.id)
    expect(r.registry.list().find((x) => x.id === procId)!.meta?.restore.carrySent).toBe(false)
    expect(r.procs[1].sent).toHaveLength(1)
    expect(r.procs[1].sent.join('')).not.toContain('carry on')
  })
})

describe('createHostChats — the carry-on on adopt (P4, Review Focus 3)', () => {
  it('sends an unsent carry-on once, marking it sent before the write, and never again on a later pass', async () => {
    const r = rig({ carryOn: 'carry on with the work', carrySent: false })
    const order: string[] = []
    const realNote = r.registry.note.bind(r.registry)
    r.registry.note = (id, patch) => { order.push(`note ${JSON.stringify(patch)}`); realNote(id, patch) }
    const realWrite = r.procs[0].write
    r.procs[0].write = (d) => { order.push('write'); realWrite(d) }
    r.chats.adopt(r.entry())
    await vi.waitFor(() => expect(order).toContain('write'))
    expect(order.indexOf('note {"carrySent":true}')).toBeLessThan(order.indexOf('write'))
    r.chats.adopt(r.entry())
    expect(r.procs[0].sent.filter((s) => s.includes('carry on with the work'))).toHaveLength(1)
  })
  it('does not send a carry-on the note says was sent', () => {
    const r = rig({ carryOn: 'carry on', carrySent: true })
    r.chats.adopt(r.entry())
    expect(r.procs[0].sent.join('')).not.toContain('carry on')
  })
})

describe('createHostChats — the carry-on on adopt, fix round 1', () => {
  const carrySentOf = (r: ReturnType<typeof rig>) => r.registry.list()[0].meta?.restore.carrySent

  // Important 2. A carry-on the adapter refused before anything reached the wire is left for the next
  // writer: the mark goes back to false.
  it('leaves carrySent false when the codex adapter refuses the carry-on (no thread yet)', async () => {
    const r = rig({ provider: 'codex', threadId: undefined, carryOn: 'carry on', carrySent: false })
    r.chats.adopt(r.entry())
    expect(r.procs[0].sent).toEqual([])
    expect(carrySentOf(r)).toBe(false)
    await vi.waitFor(() => expect(r.logs.join('\n')).toMatch(/left for the next writer/))
  })

  it('leaves carrySent false when the write is refused as NotWriterError (an app took the proc mid-send)', () => {
    const r = rig({ carryOn: 'carry on', carrySent: false })
    const realNote = r.registry.note.bind(r.registry)
    r.registry.note = (id, patch) => {
      realNote(id, patch)
      if (patch.carrySent === true) r.holders.heldBy('p1', 1)
    }
    r.chats.adopt(r.entry())
    expect(r.procs[0].sent).toEqual([])
    expect(carrySentOf(r)).toBe(false)
  })

  it('keeps carrySent true once the carry-on line was written, even when its request later rejects', async () => {
    const r = rig({ provider: 'codex', carryOn: 'carry on', carrySent: false })
    r.chats.adopt(r.entry())
    expect(r.procs[0].sent.join('')).toContain('carry on')
    const id = JSON.parse(r.procs[0].sent[0]).id
    r.procs[0].emit(`${JSON.stringify({ id, error: { code: -1, message: 'boom' } })}\n`)
    await vi.waitFor(() => expect(r.logs.join('\n')).toMatch(/carry-on could not be sent after the takeover: .*boom/))
    expect(carrySentOf(r)).toBe(true)
  })

  // Minor 3, M11: while a socket holds the proc the Host is not the writer, so it neither marks nor sends.
  it('sends no carry-on and leaves the mark alone while a socket holds the proc', () => {
    const r = rig({ carryOn: 'carry on', carrySent: false })
    const notes: string[] = []
    const realNote = r.registry.note.bind(r.registry)
    r.registry.note = (id, patch) => { notes.push(JSON.stringify(patch)); realNote(id, patch) }
    r.holders.heldBy('p1', 1)
    r.chats.adopt(r.entry())
    expect(r.procs[0].sent).toEqual([])
    expect(carrySentOf(r)).toBe(false)
    // Not even for a moment: the app, the writer, may read the note meanwhile.
    expect(notes.filter((n) => n.includes('carrySent'))).toEqual([])
  })

  // Minor 2: a throw after the adapter was made leaves no session behind, so the takeover's failure
  // path (which drops the chain) tells the truth.
  it('forgets the session and rethrows when adopt throws after the adapter was made', () => {
    const r = rig({ carryOn: 'carry on', carrySent: false })
    r.registry.note = () => { throw new Error('note failed') }
    expect(() => r.chats.adopt(r.entry())).toThrow('note failed')
    expect(r.chats.has('c1')).toBe(false)
    expect(r.chats.handleCount()).toBe(0)
  })

  // Minor 3, M2b: a second adopt of the same proc is a no-op: one adapter, one handle.
  it('a second adopt of the same proc makes no second adapter', () => {
    const r = rig()
    let made = 0
    const chats = createHostChats({
      procs: r.registry, holders: r.holders, platform: 'win32', homeDir: 'C:\\Users\\t', version: '0.0.0', baseEnv: {},
      askApp: async () => ({ sent: true }), log: () => {},
      createAdapter: () => {
        made++
        return {
          start: async () => {}, send: async () => {}, interrupt: async () => {}, answer: async () => {}, setModel: async () => {},
          setPermissionMode: async () => {}, listPermissionModes: async () => [], listModels: async () => [],
          state: () => ({ status: 'idle', request: null, model: { model: null, effort: null, permissionMode: 'default' }, error: null, exitCode: null, errorDetail: null, outlivesApp: true, truncated: false, provider: 'claude' }),
          pending: () => [], on: () => () => {}, kill: () => {}
        }
      }
    })
    expect(chats.adopt(r.entry())?.id).toBe('c1')
    expect(chats.adopt(r.entry())?.id).toBe('c1')
    expect(made).toBe(1)
    expect(chats.handleCount()).toBe(1)
  })
})

describe('createHostChats — the handles it keeps (Task 3 review)', () => {
  function exiting(): RegistryProc & { sent: string[]; emit(c: string): void; exit(code: number): void } {
    let onData: (c: string) => void = () => {}
    let onExit: (e: { exitCode: number }) => void = () => {}
    const p = { pid: 9, sent: [] as string[], onData: (cb: typeof onData) => { onData = cb }, onExit: (cb: typeof onExit) => { onExit = cb }, write: (d: string) => { p.sent.push(d) }, kill: () => {}, emit: (c: string) => onData(c), exit: (code: number) => onExit({ exitCode: code }) }
    return p
  }
  const keptRig = (o: { throwOnCreate?: boolean } = {}) => {
    const procs: ReturnType<typeof exiting>[] = []
    const registry = new ProcRegistry({ spawn: () => { const p = exiting(); procs.push(p); return p }, log: () => {} })
    registry.open({ id: 'p1', file: 'claude', args: [], opts: { cwd: 'D:/p', env: {} }, meta: note() })
    const heard: string[] = []
    const createAdapter: NonNullable<Parameters<typeof createHostChats>[0]['createAdapter']> = ({ proc }) => {
      proc.onLine((l) => heard.push(l))
      if (o.throwOnCreate) throw new Error('no adapter')
      let emit: ((e: ChatEvent) => void) | null = null
      proc.onExit(({ exitCode }) => emit?.({ type: 'exit', code: exitCode, errorDetail: null }))
      return {
        start: async () => {},
        send: async () => {},
        interrupt: async () => {},
        answer: async () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        listPermissionModes: async () => [],
        listModels: async () => [],
        state: () => ({ status: 'idle', request: null, model: { model: null, effort: null, permissionMode: 'default' }, error: null, exitCode: null, errorDetail: null, outlivesApp: true, truncated: false, provider: 'claude' }),
        pending: () => [],
        on: (fn) => { emit = fn; return () => { emit = null } },
        kill: () => {}
      }
    }
    const chats = createHostChats({ procs: registry, holders: createProcHolders(), platform: 'win32', homeDir: 'C:\\Users\\t', version: '0.0.0', baseEnv: {}, askApp: async () => ({ sent: true }), log: () => {}, createAdapter })
    return { registry, procs, chats, heard }
  }

  // Important 2. Mutation: drop the forget from manager.onExit; this test must fail.
  it('forgets a session and its handle once its proc has exited', async () => {
    const r = keptRig()
    r.chats.adopt(r.registry.list()[0])
    r.procs[0].exit(0)
    expect(r.chats.has('c1')).toBe(true) // every listener hears the exit first
    await Promise.resolve()
    expect(r.chats.has('c1')).toBe(false)
    expect(r.chats.handleCount()).toBe(0)
  })

  // Minor: a spawn that throws after its proc opened leaves no handle behind that still hears lines.
  it('releases the handle of a spawn that throws', () => {
    const r = keptRig({ throwOnCreate: true })
    expect(() => r.chats.spawn({ account, cwd: 'D:/p' })).toThrow('no adapter')
    r.procs[1].emit('late\n')
    expect(r.heard).toEqual([])
    expect(r.chats.handleCount()).toBe(0)
  })
})

describe('createHostChats — the unattended permission policy (Task 7)', () => {
  it('denies a held approval after 60 s under deny-after-60s while the Host writes, and holds by default', async () => {
    vi.useFakeTimers()
    try {
      const r = rig({ unattendedPermission: 'deny-after-60s' })
      r.procs[0].emit(`${F.CAN_USE_TOOL_WRITE}\n`)
      r.chats.adopt(r.entry())
      await vi.advanceTimersByTimeAsync(60_000)
      expect(r.procs[0].sent.join('')).toContain('"behavior":"deny"')
      expect(r.logs.join('\n')).toMatch(/unattended: denied \S+ in session c1 after 60 s \(policy deny-after-60s\)/)
      const held = rig()
      held.procs[0].emit(`${F.CAN_USE_TOOL_WRITE}\n`)
      held.chats.adopt(held.entry())
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(held.procs[0].sent.join('')).not.toContain('"behavior":"deny"')
    } finally {
      vi.useRealTimers()
    }
  })

  // Review Focus 4 through the real holders: the app attaching at 59 s stops the deny.
  it('does not deny once an app attaches before the 60 s are up, and counts again from its leave', async () => {
    vi.useFakeTimers()
    try {
      const r = rig({ unattendedPermission: 'deny-after-60s' })
      r.procs[0].emit(`${F.CAN_USE_TOOL_WRITE}\n`)
      r.chats.adopt(r.entry())
      await vi.advanceTimersByTimeAsync(59_000)
      r.holders.heldBy('p1', 1)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(r.procs[0].sent.join('')).not.toContain('"behavior":"deny"')
      r.holders.appGone(1)
      await vi.advanceTimersByTimeAsync(59_000)
      expect(r.procs[0].sent.join('')).not.toContain('"behavior":"deny"')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(r.procs[0].sent.join('')).toContain('"behavior":"deny"')
    } finally {
      vi.useRealTimers()
    }
  })

  // A forgotten or disposed session's armed timer never denies: the forget cancels it and the fire asks
  // again (so no single mutation here makes this fail; chatPolicy.test.ts covers each half).
  it('arms nothing after a forget or a dispose', async () => {
    vi.useFakeTimers()
    try {
      const kept = rig({ unattendedPermission: 'deny-after-60s' })
      const gone = rig({ unattendedPermission: 'deny-after-60s' })
      const disposed = rig({ unattendedPermission: 'deny-after-60s' })
      for (const r of [kept, gone, disposed]) {
        r.procs[0].emit(`${F.CAN_USE_TOOL_WRITE}\n`)
        r.chats.adopt(r.entry())
      }
      await vi.advanceTimersByTimeAsync(30_000)
      gone.chats.forget('c1')
      disposed.chats.dispose()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(kept.procs[0].sent.join('')).toContain('"behavior":"deny"')
      expect(gone.procs[0].sent.join('')).not.toContain('"behavior":"deny"')
      expect(disposed.procs[0].sent.join('')).not.toContain('"behavior":"deny"')
    } finally {
      vi.useRealTimers()
    }
  })
})
