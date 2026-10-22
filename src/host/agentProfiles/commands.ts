// The Host's `agent-profiles-*` commands (Agent Profiles design §4): the Host owns the profile store, so the app and this
// machine's CLI change it through here. Like the `extensions-*` commands they are for the app and the CLI, and an
// agent's shell may read but not change. An MCP client may read them too (list_agent_profiles, design §6), behind the
// MCP gate (core/host/mcpGate.ts), and change none.
import { RepairNeeded } from '../../core/settings/repairNeeded'
import { findProfile, liveAccounts, readAgentProfiles, validateProfile, writeAgentProfiles, type ProfileInput } from '../../core/agentProfiles/store'
import type { AgentProfile, ProfilePermission } from '../../core/agentProfiles/types'
import type { OrchCaller } from '../../core/host/orchProtocol'
import type { Account } from '../../core/types'
import { agentProfileIdOf } from '../../core/sessions/noteInfo'
import { holdsAgentProfile } from '../../core/orchestration/running'
import type { OrchState } from '../../core/orchestration/state'

export const AGENT_PROFILE_COMMANDS: ReadonlySet<string> = new Set([
  'agent-profiles-list',
  'agent-profiles-get',
  'agent-profiles-create',
  'agent-profiles-update',
  'agent-profiles-archive',
  'agent-profiles-restore',
  'agent-profiles-delete',
  'agent-profiles-touch'
])

/** The ones that change the store: all but the two reads and the use stamp, which is not a person's change. */
export const AGENT_PROFILE_CHANGES: ReadonlySet<string> = new Set([
  'agent-profiles-create',
  'agent-profiles-update',
  'agent-profiles-archive',
  'agent-profiles-restore',
  'agent-profiles-delete'
])

export interface AgentProfilesAnswer {
  status: number
  body: unknown
}

export interface HostAgentProfiles {
  command(a: {
    cmd: string
    args: Record<string, unknown>
    role: OrchCaller['role'] | undefined
    /** The sentence an agent's shell is refused with, present exactly when the caller is one. */
    agentRefusal?: string
    marks: { effects: number }
  }): Promise<AgentProfilesAnswer>
}

/** The two reads, the ones an MCP client may also send. */
const AGENT_PROFILE_READS: ReadonlySet<string> = new Set(['agent-profiles-list', 'agent-profiles-get'])

/** `lastUsedAt` is stamped at most this often per profile. */
const TOUCH_EVERY_MS = 60_000
const PERMISSIONS: readonly ProfilePermission[] = ['inherit', 'bypass', 'ask']

const bad = (error: string): AgentProfilesAnswer => ({ status: 400, body: { error } })
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

export function createHostAgentProfiles(d: {
  profileDir: string
  readAccounts: () => Promise<Account[]>
  /** Whether a live thing still holds the profile, so that deleting it would pull it from under that. */
  inUse: (id: string) => Promise<boolean>
  now?: () => number
  log: (line: string) => void
}): HostAgentProfiles {
  const now = d.now ?? Date.now
  // One change at a time: two updates must each read what the other wrote
  let chain: Promise<unknown> = Promise.resolve()
  const queued = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f)
    chain = run.catch(() => {})
    return run
  }

  /** A removed account is dropped from what the caller sees, as the store's design says. */
  const shown = (p: AgentProfile, accounts: Account[]): AgentProfile => ({ ...p, accountIds: liveAccounts(p, accounts) })

  const rejected = (reason: string): AgentProfilesAnswer => ({ status: 400, body: { error: `the profile was refused (${reason})`, reason } })

  const answer = async (cmd: string, args: Record<string, unknown>): Promise<AgentProfilesAnswer> => {
    switch (cmd) {
      case 'agent-profiles-list': {
        const s = await readAgentProfiles(d.profileDir)
        const accounts = await d.readAccounts()
        return { status: 200, body: { profiles: s.profiles.map((p) => shown(p, accounts)) } }
      }
      case 'agent-profiles-get': {
        if (typeof args.idOrName !== 'string' || args.idOrName === '') return bad('agent-profiles-get needs idOrName')
        const p = findProfile(await readAgentProfiles(d.profileDir), args.idOrName)
        if (!p) return { status: 404, body: { error: `no agent profile ${args.idOrName}` } }
        return { status: 200, body: { profile: shown(p, await d.readAccounts()) } }
      }
      case 'agent-profiles-create': {
        if (typeof args.name !== 'string' || !strings(args.accountIds)) return bad('agent-profiles-create needs name and accountIds')
        if (args.description !== undefined && typeof args.description !== 'string') return bad('description must be text')
        if (args.mcpExclude !== undefined && !strings(args.mcpExclude)) return bad('mcpExclude must be a list of ids')
        if (args.permission !== undefined && !PERMISSIONS.includes(args.permission as ProfilePermission)) return bad('permission must be inherit, bypass or ask')
        const input: ProfileInput = {
          name: args.name,
          accountIds: args.accountIds,
          ...(args.description !== undefined ? { description: args.description as string } : {}),
          ...(args.mcpExclude !== undefined ? { mcpExclude: args.mcpExclude as string[] } : {}),
          ...(args.permission !== undefined ? { permission: args.permission as ProfilePermission } : {})
        }
        return queued(async () => {
          const s = await readAgentProfiles(d.profileDir)
          const accounts = await d.readAccounts()
          const at = new Date(now()).toISOString()
          const v = validateProfile({ ...input, createdAt: at, updatedAt: at }, accounts, s.profiles)
          if (!v.ok) return rejected(v.reason)
          await writeAgentProfiles(d.profileDir, { ...s, profiles: [...s.profiles, v.profile] })
          return { status: 200, body: { profile: shown(v.profile, accounts) } }
        })
      }
      case 'agent-profiles-update': {
        if (typeof args.id !== 'string') return bad('agent-profiles-update needs id')
        if (args.name !== undefined && typeof args.name !== 'string') return bad('name must be text')
        if (args.description !== undefined && typeof args.description !== 'string') return bad('description must be text')
        if (args.accountIds !== undefined && !strings(args.accountIds)) return bad('accountIds must be a list of ids')
        if (args.mcpExclude !== undefined && !strings(args.mcpExclude)) return bad('mcpExclude must be a list of ids')
        if (args.permission !== undefined && !PERMISSIONS.includes(args.permission as ProfilePermission)) return bad('permission must be inherit, bypass or ask')
        const { id } = args
        return queued(async () => {
          const s = await readAgentProfiles(d.profileDir)
          const old = s.profiles.find((p) => p.id === id)
          if (!old) return { status: 404, body: { error: `no agent profile ${id}` } }
          const accounts = await d.readAccounts()
          const v = validateProfile(
            {
              ...old,
              ...(args.name !== undefined ? { name: args.name as string } : {}),
              ...(args.description !== undefined ? { description: args.description as string } : {}),
              ...(args.accountIds !== undefined ? { accountIds: args.accountIds as string[] } : {}),
              ...(args.mcpExclude !== undefined ? { mcpExclude: args.mcpExclude as string[] } : {}),
              ...(args.permission !== undefined ? { permission: args.permission as ProfilePermission } : {}),
              updatedAt: new Date(now()).toISOString()
            },
            accounts,
            s.profiles.filter((p) => p.id !== id)
          )
          if (!v.ok) return rejected(v.reason)
          await writeAgentProfiles(d.profileDir, { ...s, profiles: s.profiles.map((p) => (p.id === id ? v.profile : p)) })
          return { status: 200, body: { profile: shown(v.profile, accounts) } }
        })
      }
      case 'agent-profiles-archive':
      case 'agent-profiles-restore': {
        if (typeof args.id !== 'string') return bad(`${cmd} needs id`)
        const { id } = args
        const status = cmd === 'agent-profiles-archive' ? 'archived' : 'active'
        return queued(async () => {
          const s = await readAgentProfiles(d.profileDir)
          const old = s.profiles.find((p) => p.id === id)
          if (!old) return { status: 404, body: { error: `no agent profile ${id}` } }
          const next: AgentProfile = { ...old, status, updatedAt: new Date(now()).toISOString() }
          await writeAgentProfiles(d.profileDir, { ...s, profiles: s.profiles.map((p) => (p.id === id ? next : p)) })
          return { status: 200, body: { profile: shown(next, await d.readAccounts()) } }
        })
      }
      case 'agent-profiles-delete': {
        if (typeof args.id !== 'string') return bad('agent-profiles-delete needs id')
        const { id } = args
        return queued(async () => {
          const s = await readAgentProfiles(d.profileDir)
          if (!s.profiles.some((p) => p.id === id)) return { status: 404, body: { error: `no agent profile ${id}` } }
          if (await d.inUse(id)) return { status: 409, body: { error: 'the profile is in use; archive it instead', reason: 'in-use' } }
          await writeAgentProfiles(d.profileDir, { ...s, profiles: s.profiles.filter((p) => p.id !== id) })
          return { status: 200, body: {} }
        })
      }
      case 'agent-profiles-touch': {
        // Stamping a use must never fail the spawn that asks: every problem is logged and answered as success
        if (typeof args.id !== 'string') return { status: 200, body: {} }
        const { id } = args
        return queued(async () => {
          try {
            const s = await readAgentProfiles(d.profileDir)
            const old = s.profiles.find((p) => p.id === id)
            if (!old) return { status: 200, body: {} }
            const last = old.lastUsedAt === undefined ? NaN : Date.parse(old.lastUsedAt)
            if (now() - last < TOUCH_EVERY_MS) return { status: 200, body: {} }
            await writeAgentProfiles(d.profileDir, { ...s, profiles: s.profiles.map((p) => (p.id === id ? { ...p, lastUsedAt: new Date(now()).toISOString() } : p)) })
          } catch (e) {
            d.log(`agent profiles: could not stamp the use of ${id} (${message(e)})`)
          }
          return { status: 200, body: {} }
        })
      }
      default:
        return { status: 501, body: { error: `${cmd} is not answered by this Host` } }
    }
  }

  return {
    command: async (a) => {
      const reader = a.role === 'mcp' && AGENT_PROFILE_READS.has(a.cmd)
      if (a.role !== 'app' && a.role !== 'cli' && !reader) return { status: 403, body: { error: `${a.cmd} is for this machine's app and CLI only` } }
      if (AGENT_PROFILE_CHANGES.has(a.cmd) && a.agentRefusal !== undefined) return { status: 403, body: { error: a.agentRefusal } }
      let r: AgentProfilesAnswer
      try {
        r = await answer(a.cmd, a.args)
      } catch (e) {
        // A damaged store or accounts file is the person's to repair in the app (RepairNeeded), anything else failed
        r = { status: e instanceof RepairNeeded ? 409 : 500, body: { error: message(e) } }
      }
      if (r.status === 200 && AGENT_PROFILE_CHANGES.has(a.cmd)) a.marks.effects += 1
      return r
    }
  }
}

/** The delete guard's `inUse` (ruling P1): a live session this Host holds that was started from the profile (its note
 *  carries the id), or unfinished orchestration work that names it (holdsAgentProfile). The state is loaded first, as
 *  every orchestration command loads it: a Task queued before a restart holds the profile as much as a running one. */
export function agentProfileInUse(d: {
  sessions: () => Array<{ alive: boolean; meta?: { restore?: Record<string, unknown> } | null }>
  /** Asked only when a delete is: the load stays lazy (createHostOrch) */
  orch: () => { ready(): Promise<void>; state(): OrchState }
}): (id: string) => Promise<boolean> {
  return async (id) => {
    if (d.sessions().some((e) => e.alive && agentProfileIdOf(e.meta?.restore) === id)) return true
    const orch = d.orch()
    await orch.ready()
    return holdsAgentProfile(orch.state(), id)
  }
}
