import { describe, it, expect, vi, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { announceChatProc, createHostSessionStarter } from './sessionCreate'
import { wasRefusedBeforeActing } from '../core/host/orchProtocol'
import type { HostSession } from '../core/orchestration/command'
import type { Account, SessionInfo } from '../core/types'
import { removeFixture } from '../core/testFixtures'
import { writeAgentProfiles } from '../core/agentProfiles/store'
import type { AgentProfile } from '../core/agentProfiles/types'
import { profilePaths } from '../core/profile/paths'
import { RepairNeeded } from '../core/settings/repairNeeded'

const ACCOUNT: Account = { id: 'acc_c', label: 'C', configDir: '/cfg/c', color: '#000', createdAt: 'T', provider: 'claude' }

const rig = (over: Partial<Parameters<typeof createHostSessionStarter>[0]> = {}) => {
  const rows: HostSession[] = []
  const announced: string[] = []
  const info = (id: string, o: { cwd: string; title?: string }): SessionInfo =>
    ({ id, accountId: 'acc_c', cwd: o.cwd, title: o.title ?? 'p', status: 'running' }) as SessionInfo
  const spawner = {
    createSession: vi.fn(async (o: { accountId: string; cwd: string; title?: string }) => {
      rows.push({ id: 'term_1', kind: 'terminal', title: o.title ?? 'p', accountId: o.accountId, cwd: o.cwd, alive: true, state: 'unknown' })
      return info('term_1', o)
    })
  }
  const chats = {
    spawn: vi.fn((o: { cwd: string; title?: string }) => {
      rows.push({ id: 'chat_1', kind: 'chat', title: o.title ?? 'p', accountId: 'acc_c', cwd: o.cwd, alive: true, state: 'unknown' })
      return info('chat_1', o)
    }),
    started: vi.fn(async () => true),
    procOf: vi.fn(() => 'proc_1')
  }
  const rolling = { adoptSpawned: vi.fn() }
  const start = createHostSessionStarter({
    spawner,
    chats,
    rolling,
    readAccounts: async () => [ACCOUNT],
    bypass: async () => false,
    probeCwd: async () => 'present' as const,
    announceProc: (p) => announced.push(p),
    list: async () => rows,
    log: () => {},
    ...over
  })
  return { start, spawner, chats, rolling, announced }
}

describe('createHostSessionStarter — sessions create, by the spawn paths the Host already has', () => {
  it('a terminal session goes through the spawner, and the answer is its sessions list row', async () => {
    const h = rig()
    const r = await h.start({ kind: 'terminal', accountId: 'acc_c', cwd: '/repo', title: 'fix', prompt: 'go', rollAccountIds: ['acc_c'] })
    expect(h.spawner.createSession).toHaveBeenCalledWith({ accountId: 'acc_c', cwd: '/repo', title: 'fix', initialPrompt: 'go', rollAccountIds: ['acc_c'] })
    expect(r).toMatchObject({ id: 'term_1', kind: 'terminal', cwd: '/repo', alive: true })
    expect(h.chats.spawn).not.toHaveBeenCalled()
  })

  it('a chat session goes through the chat manager with the bypass and policy, waits for its start, then is announced', async () => {
    const h = rig({ bypass: async () => true })
    const r = await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', prompt: 'hello', rollAccountIds: ['acc_c', 'acc_c2'], unattended: 'deny-after-60s' })
    expect(h.chats.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ account: ACCOUNT, cwd: '/repo', bypassPermissions: true, initialPrompt: 'hello', rollAccountIds: ['acc_c', 'acc_c2'], unattendedPermission: 'deny-after-60s' })
    )
    expect(h.chats.started).toHaveBeenCalledWith('chat_1')
    expect(h.rolling.adoptSpawned).toHaveBeenCalledTimes(1)
    expect(h.announced).toEqual(['proc_1'])
    expect(r).toMatchObject({ id: 'chat_1', kind: 'chat' })
  })

  // Agent Control Plane release 1: a chat spawn is synchronous, so the account's shared servers are resolved first
  it('resolves the account’s shared extensions before the chat spawn', async () => {
    const order: string[] = []
    const h = rig({ refreshCapabilities: async (a) => { order.push(`refresh ${a.id}`) } })
    h.chats.spawn.mockImplementationOnce((o: { cwd: string }) => {
      order.push('spawn')
      return { id: 'chat_1', accountId: 'acc_c', cwd: o.cwd, title: 'p', status: 'running' } as SessionInfo
    })
    await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [] })
    expect(order).toEqual(['refresh acc_c', 'spawn'])
  })

  // 2026-10-20: a chat session an agent made is an agent's too, and its tab closes when it ends
  it('passes who started the session on, to the chat manager and the spawner, and nothing for a person’s', async () => {
    const h = rig()
    await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], startedBy: 'agent' })
    expect(h.chats.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ startedBy: 'agent' }))
    await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [] })
    expect(h.chats.spawn.mock.calls.at(-1)![0]).not.toHaveProperty('startedBy')
    await h.start({ kind: 'terminal', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], startedBy: 'agent' })
    expect(h.spawner.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ startedBy: 'agent' }))
  })
  it('a chat session with no chain registers none', async () => {
    const h = rig()
    await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], unattended: 'hold' })
    expect(h.rolling.adoptSpawned).not.toHaveBeenCalled()
  })

  it('a chat start that does not settle is a failure, and nothing is announced', async () => {
    const h = rig()
    h.chats.started.mockResolvedValueOnce(false)
    await expect(h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [] })).rejects.toThrow(/did not finish starting/)
    expect(h.announced).toEqual([])
  })

  it('refusals before a chat spawn start nothing and are tagged so no receipt is kept', async () => {
    for (const over of [
      { readAccounts: async () => [] },
      { probeCwd: async () => 'absent' as const },
      { probeCwd: async () => 'timeout' as const },
      {
        bypass: async () => {
          throw new Error('app-settings.json is damaged; open Astera to repair it')
        }
      }
    ]) {
      const h = rig(over)
      const err = await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [] }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(wasRefusedBeforeActing(err)).toBe(true)
      expect(h.chats.spawn).not.toHaveBeenCalled()
    }
  })

  it('a chat folder that does not answer in time is refused as not reachable, not as missing', async () => {
    const h = rig({ probeCwd: async () => 'timeout' as const })
    const err = await h.start({ kind: 'chat', accountId: 'acc_c', cwd: 'Z:/offline', rollAccountIds: [] }).catch((e: unknown) => e)
    expect(String(err)).toContain('CWD_UNREACHABLE: folder not reachable: Z:/offline')
    expect(h.chats.spawn).not.toHaveBeenCalled()
  })

  // Security review 2026-09-28: the command layer refuses cmd.exe syntax in a terminal prompt; the
  // Host is the layer that spawns, so it refuses it too, before anything starts.
  it('a terminal prompt with cmd.exe syntax is refused here too, and nothing is spawned', async () => {
    const h = rig()
    const err = await h.start({ kind: 'terminal', accountId: 'acc_c', cwd: '/repo', prompt: 'hi|calc.exe', rollAccountIds: [] }).catch((e: unknown) => e)
    expect(String(err)).toContain('line break')
    expect(wasRefusedBeforeActing(err)).toBe(true)
    expect(h.spawner.createSession).not.toHaveBeenCalled()
  })

  it('a Host with no spawner starts nothing', async () => {
    const h = rig({ spawner: null, chats: null })
    for (const kind of ['terminal', 'chat'] as const) {
      const err = await h.start({ kind, accountId: 'acc_c', cwd: '/repo', rollAccountIds: [] }).catch((e: unknown) => e)
      expect(String(err)).toContain('without the agent CLI paths')
      expect(wasRefusedBeforeActing(err)).toBe(true)
    }
  })
})

// Review 3, M3: a chat proc the Host opened is told only to the apps that take chat sessions back.
describe('announceChatProc — proc-opened, to chat-takeover apps only', () => {
  it('broadcasts proc-opened with a filter that admits only apps yielding chat-takeover', () => {
    const sent: Array<{ m: unknown; to?: (y: ReadonlySet<string>) => boolean }> = []
    announceChatProc({ broadcast: (m, to) => sent.push({ m, to }) }, 'proc_1', () => {})
    expect(sent).toHaveLength(1)
    expect(sent[0].m).toEqual({ t: 'proc-opened', procId: 'proc_1' })
    expect(sent[0].to?.(new Set(['chat-takeover', 'dispatch']))).toBe(true)
    expect(sent[0].to?.(new Set(['dispatch']))).toBe(false)
    expect(sent[0].to?.(new Set())).toBe(false)
  })

  it('a broadcast that throws is logged, never thrown', () => {
    const logs: string[] = []
    announceChatProc({ broadcast: () => { throw new Error('socket gone') } }, 'proc_1', (m) => logs.push(m))
    expect(logs.join(' ')).toContain('proc_1')
  })

  // Phase 9a review M10: a controller that just made a session must be able to subscribe to it, even when the row is not
  // listed yet: the answer carries its pty or process, provider and sources all the same.
  it('a row not listed yet still carries the pty or process, the provider and the sources', async () => {
    const r = rig({ list: async () => [], ptyOf: () => 'pty_9' })
    const term = await r.start({ kind: 'terminal', accountId: 'acc_c', cwd: '/p', rollAccountIds: [] } as never)
    expect(term).toMatchObject({ id: 'term_1', ptyId: 'pty_9', provider: 'claude', sources: { status: 'hooks', conversation: 'transcript' } })
    const chat = await r.start({ kind: 'chat', accountId: 'acc_c', cwd: '/p', rollAccountIds: [], unattended: 'hold' } as never)
    expect(chat).toMatchObject({ id: 'chat_1', procId: 'proc_1', provider: 'claude', sources: { status: 'chat' } })
  })
})

// Agent Profiles design §5: a chat session started from a profile behaves like a terminal one: the profile's servers and
// its permission choice, its real id kept, and its use stamped once it started
describe('createHostSessionStarter — with an agent profile', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeFixture(d)
  })
  const P = (over: Partial<AgentProfile>): AgentProfile => ({
    id: 'ap_000000000001', name: 'Reviewer', status: 'active', accountIds: ['acc_c'], mcpExclude: [], permission: 'inherit', sandbox: false,
    createdAt: 'T', updatedAt: 'T', ...over
  })
  const withProfiles = async (profiles: AgentProfile[]): Promise<string> => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-sesscreate-'))
    dirs.push(d)
    await writeAgentProfiles(d, { version: 1, profiles })
    return d
  }

  it('a chat session gets the profile’s id, servers and bypass, and its use is stamped after it started', async () => {
    const profileDir = await withProfiles([P({ id: 'ap_b', name: 'Night shift', permission: 'bypass' })])
    const refreshed: Array<[string, string | undefined]> = []
    const touched: string[] = []
    const h = rig({
      profileDir,
      bypass: async () => false,
      refreshCapabilities: async (a, id) => { refreshed.push([a.id, id]) },
      touchAgentProfile: (id) => touched.push(id)
    })
    await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], agentProfileId: 'night shift' })
    expect(refreshed).toEqual([['acc_c', 'ap_b']])
    expect(h.chats.spawn).toHaveBeenCalledWith(expect.objectContaining({ bypassPermissions: true, agentProfileId: 'ap_b' }))
    expect(touched).toEqual(['ap_b'])
  })

  it('an ask profile asks while the app-wide mode is yolo', async () => {
    const profileDir = await withProfiles([P({ id: 'ap_a', permission: 'ask' })])
    const h = rig({ profileDir, bypass: async () => true })
    await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], agentProfileId: 'ap_a' })
    expect(h.chats.spawn).toHaveBeenCalledWith(expect.objectContaining({ bypassPermissions: false, agentProfileId: 'ap_a' }))
  })

  it('a profile that does not resolve starts the chat as before, without an id, logged once', async () => {
    const profileDir = await withProfiles([P({})])
    const logs: string[] = []
    const touched: string[] = []
    const h = rig({ profileDir, bypass: async () => true, log: (m) => logs.push(m), touchAgentProfile: (id) => touched.push(id) })
    await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], agentProfileId: 'ap_gone' })
    expect(h.chats.spawn.mock.calls[0][0]).not.toHaveProperty('agentProfileId')
    expect(h.chats.spawn).toHaveBeenCalledWith(expect.objectContaining({ bypassPermissions: true }))
    expect(logs.filter((l) => l.includes('ap_gone'))).toHaveLength(1)
    expect(touched).toEqual([])
  })

  // Task 5 fix round 1: a store that cannot be read may hold the profile's sandbox or its `ask`, so the chat does not start
  // without it: refused before anything started, with the repair the store needs
  it('a damaged profile store refuses a chat that names a profile, and starts nothing', async () => {
    const profileDir = await withProfiles([P({})])
    await fs.writeFile(profilePaths(profileDir).agentProfiles, '{ damaged')
    const h = rig({ profileDir, bypass: async () => true })
    const refused = await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], agentProfileId: 'ap_000000000001' }).then(
      () => null,
      (e: unknown) => e
    )
    expect(refused).toBeInstanceOf(RepairNeeded)
    expect((refused as RepairNeeded).file).toBe('agent-profiles.json')
    expect(wasRefusedBeforeActing(refused as Error)).toBe(true)
    expect(h.chats.spawn).not.toHaveBeenCalled()
  })

  // Sandbox design §6: a sandboxed profile's chat has its folder read (and on Windows its account asked) before the spawn,
  // and a refusal there starts nothing, tagged so no receipt is kept
  it('a sandboxed profile’s chat is prepared for the sandbox first, and started in it', async () => {
    const profileDir = await withProfiles([P({ id: 'ap_box', sandbox: true })])
    const order: string[] = []
    const h = rig({ profileDir })
    const prepare = vi.fn(async (o: { account: Account; cwd: string; sandbox?: boolean }) => {
      order.push(`prepare ${o.account.id} ${o.cwd} ${String(o.sandbox)}`)
    })
    Object.assign(h.chats, { prepare })
    h.chats.spawn.mockImplementationOnce((o: { cwd: string }) => {
      order.push('spawn')
      return { id: 'chat_1', accountId: 'acc_c', cwd: o.cwd, title: 'p', status: 'running' } as SessionInfo
    })
    await h.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], agentProfileId: 'ap_box' })
    expect(order).toEqual(['prepare acc_c /repo true', 'spawn'])
    expect(h.chats.spawn).toHaveBeenCalledWith(expect.objectContaining({ sandbox: true, agentProfileId: 'ap_box' }))
    // Unsandboxed, nothing is prepared and the spawn is asked as before
    const open = rig({ profileDir: await withProfiles([P({ id: 'ap_open' })]) })
    const noPrepare = vi.fn(async () => {})
    Object.assign(open.chats, { prepare: noPrepare })
    await open.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], agentProfileId: 'ap_open' })
    expect(noPrepare).not.toHaveBeenCalled()
    expect(open.chats.spawn.mock.calls[0][0]).not.toHaveProperty('sandbox')
    // A refusal: nothing is spawned, and it is tagged as refused before acting
    const refusing = rig({ profileDir })
    Object.assign(refusing.chats, { prepare: async () => Promise.reject(new Error('SANDBOX_UNAVAILABLE: windows-setup codex acc_c')) })
    const err = await refusing.start({ kind: 'chat', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], agentProfileId: 'ap_box' }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('SANDBOX_UNAVAILABLE: windows-setup codex acc_c')
    expect(wasRefusedBeforeActing(err as Error)).toBe(true)
    expect(refusing.chats.spawn).not.toHaveBeenCalled()
  })

  // The answer is the row `sessions list` will show, the mark of the sandbox and its kind with it, before it is listed
  it('a sandboxed session’s answer says it is sandboxed and how, before it is listed', async () => {
    const h = rig({ list: async () => [] })
    h.spawner.createSession.mockImplementationOnce(
      async (o: { accountId: string; cwd: string }) =>
        ({ id: 'term_s', accountId: o.accountId, cwd: o.cwd, title: 'p', status: 'running', sandboxed: true, sandboxKind: 'sandbox' }) as SessionInfo
    )
    expect(await h.start({ kind: 'terminal', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], sandbox: true })).toMatchObject({
      id: 'term_s',
      sandboxed: true,
      sandboxKind: 'sandbox'
    })
    const plain = await h.start({ kind: 'terminal', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [] })
    expect(plain).not.toHaveProperty('sandboxed')
    expect(plain).not.toHaveProperty('sandboxKind')
  })

  it('a terminal session hands the profile to the spawner, which resolves it', async () => {
    const h = rig()
    await h.start({ kind: 'terminal', accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], agentProfileId: 'ap_b' })
    expect(h.spawner.createSession).toHaveBeenCalledWith({ accountId: 'acc_c', cwd: '/repo', rollAccountIds: [], agentProfileId: 'ap_b' })
  })
})
