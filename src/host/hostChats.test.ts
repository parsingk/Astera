import { describe, it, expect, vi } from 'vitest'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { createProcHolders } from './procHolders'
import { createHostChats } from './hostChats'
import * as F from '../core/chat/claudeFixtures'
import type { Account } from '../core/types'

const account: Account = { id: 'a1', label: 'a1', configDir: 'C:\\c1', color: '#fff', createdAt: '2026-09-26T00:00:00Z' }
function fake(): RegistryProc & { sent: string[]; emit(c: string): void } {
  let onData: (c: string) => void = () => {}
  const p = { pid: 9, sent: [] as string[], onData: (cb: typeof onData) => { onData = cb }, onExit: () => {}, write: (d: string) => { p.sent.push(d) }, kill: () => {}, emit: (c: string) => onData(c) }
  return p
}
const note = (over: Record<string, unknown> = {}) => ({ kind: 'chat' as const, id: 'c1', restore: { accountId: 'a1', cwd: 'D:/p', title: 't', provider: 'claude', threadId: 'th', unattendedPermission: 'hold', ...over } })

const rig = (restore: Record<string, unknown> = {}) => {
  const procs: ReturnType<typeof fake>[] = []
  const registry = new ProcRegistry({ spawn: () => { const p = fake(); procs.push(p); return p }, log: () => {} })
  registry.open({ id: 'p1', file: 'claude', args: [], opts: { cwd: 'D:/p', env: {} }, meta: note(restore) })
  const holders = createProcHolders()
  const askApp = vi.fn(async () => ({ sent: true }))
  const logs: string[] = []
  const chats = createHostChats({ procs: registry, holders, platform: 'win32', homeDir: 'C:\\Users\\t', version: '0.0.0', baseEnv: {}, askApp, log: (m) => logs.push(m) })
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

  it('spawns a roll respawn marked hostStarting, and clears the mark once started', async () => {
    const r = rig()
    const info = r.chats.spawn({ account, cwd: 'D:/p', resumeSessionId: 'th', restoreExtra: { rolledFrom: 'c1' } })
    const e = r.registry.list().find((x) => x.meta?.id === info.id)!
    expect(e.meta?.restore).toMatchObject({ hostStarting: true, rolledFrom: 'c1', rolledBy: 'host' })
    r.procs[1].emit(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: JSON.parse(r.procs[1].sent[0]).request_id, response: {} } })}\n`)
    await r.chats.started(info.id)
    expect(r.registry.list().find((x) => x.meta?.id === info.id)!.meta?.restore.hostStarting).toBeNull()
  })

  it('started() gives up after CHAT_START_PUSH_MS and still clears the mark', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      const info = r.chats.spawn({ account, cwd: 'D:/p' })
      const s = r.chats.started(info.id)
      await vi.advanceTimersByTimeAsync(45_000)
      await expect(s).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
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
    const chats = createHostChats({ procs: registry, holders: createProcHolders(), platform: 'win32', homeDir: 'C:\Users\t', version: '0.0.0', baseEnv: {}, askApp: async () => ({ sent: true }), log: () => {}, createAdapter })
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
