// Agent Profiles design §5: an explicit `bypass` or `ask` overrides the app-wide agentPermissionMode, `inherit` changes
// nothing; a spawn names its profile by id or name and the session keeps the real id; one that does not resolve starts
// the session as before profiles, logged once.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { profilePaths } from '../profile/paths'
import { RepairNeeded } from '../settings/repairNeeded'
import { writeAgentProfiles } from './store'
import type { AgentProfile } from './types'
import { appProfileSpawn, bypassFor, profileSpawn } from './permission'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profileDir = async (profiles: AgentProfile[] = []): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-apperm-'))
  dirs.push(d)
  if (profiles.length > 0) await writeAgentProfiles(d, { version: 1, profiles })
  return d
}
const P = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'ap_000000000001', name: 'Reviewer', status: 'active', accountIds: ['acc1'], mcpExclude: [], permission: 'inherit', sandbox: false,
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', ...over
})
const reader = (yolo: boolean) => {
  let calls = 0
  return { read: async () => { calls += 1; return yolo }, calls: () => calls }
}

describe('bypassFor', () => {
  it.each([
    ['bypass', false, true, 0],
    ['ask', true, false, 0],
    ['inherit', true, true, 1],
    ['inherit', false, false, 1],
    [undefined, true, true, 1],
    [undefined, false, false, 1]
  ] as const)('%s with the app-wide yolo %s is %s', async (permission, yolo, want, reads) => {
    const r = reader(yolo)
    expect(await bypassFor(permission, r.read)).toBe(want)
    expect(r.calls()).toBe(reads)
  })

  it('a damaged settings file still refuses an inherit or no profile spawn', async () => {
    const damaged = async (): Promise<boolean> => { throw new RepairNeeded('app-settings.json is damaged', 'app-settings.json') }
    await expect(bypassFor('inherit', damaged)).rejects.toBeInstanceOf(RepairNeeded)
    await expect(bypassFor(undefined, damaged)).rejects.toBeInstanceOf(RepairNeeded)
  })
})

describe('profileSpawn', () => {
  const call = async (dir: string, over: { agentProfileId?: string; bypassPermissions?: boolean; yolo?: boolean } = {}) => {
    const logs: string[] = []
    const r = await profileSpawn({
      profileDir: dir,
      ...(over.agentProfileId !== undefined ? { agentProfileId: over.agentProfileId } : {}),
      ...(over.bypassPermissions !== undefined ? { bypassPermissions: over.bypassPermissions } : {}),
      appWideYolo: async () => over.yolo ?? true,
      log: (l) => logs.push(l)
    })
    return { r, logs }
  }

  it('is null and reads nothing when the spawn names no profile', async () => {
    const dir = await profileDir()
    await fs.writeFile(profilePaths(dir).agentProfiles, '{ damaged')
    expect(await call(dir)).toEqual({ r: null, logs: [] })
  })

  it('gives the profile\'s real id and its permission', async () => {
    const dir = await profileDir([P({ id: 'ap_b', name: 'Bypasser', permission: 'bypass' }), P({ id: 'ap_a', name: 'Asker', permission: 'ask' })])
    expect((await call(dir, { agentProfileId: 'ap_b', yolo: false })).r).toEqual({ agentProfileId: 'ap_b', bypassPermissions: true, sandbox: false })
    expect((await call(dir, { agentProfileId: 'ap_a', yolo: true })).r).toEqual({ agentProfileId: 'ap_a', bypassPermissions: false, sandbox: false })
  })

  // Ruling (b): the Host's delete guard compares ids, so a name the caller passed must not be what the session keeps
  it('resolves a name to the profile\'s id', async () => {
    const dir = await profileDir([P({ id: 'ap_r', name: 'Reviewer', permission: 'inherit' })])
    expect((await call(dir, { agentProfileId: 'reviewer', yolo: true })).r).toEqual({ agentProfileId: 'ap_r', bypassPermissions: true, sandbox: false })
  })

  it('an explicit bypassPermissions from the caller still wins', async () => {
    const dir = await profileDir([P({ id: 'ap_b', permission: 'bypass' }), P({ id: 'ap_a', name: 'Asker', permission: 'ask' })])
    expect((await call(dir, { agentProfileId: 'ap_b', bypassPermissions: false })).r).toEqual({ agentProfileId: 'ap_b', bypassPermissions: false, sandbox: false })
    expect((await call(dir, { agentProfileId: 'ap_a', bypassPermissions: true })).r).toEqual({ agentProfileId: 'ap_a', bypassPermissions: true, sandbox: false })
  })

  // Sandbox design §6: the switch travels with the profile to every spawn path, whatever the caller's own bypass
  it("gives the profile's sandbox switch", async () => {
    const dir = await profileDir([P({ id: 'ap_s', name: 'Boxed', sandbox: true }), P({ id: 'ap_o', name: 'Open' })])
    expect((await call(dir, { agentProfileId: 'ap_s', bypassPermissions: true })).r).toEqual({ agentProfileId: 'ap_s', bypassPermissions: true, sandbox: true })
    expect((await call(dir, { agentProfileId: 'boxed' })).r).toMatchObject({ sandbox: true })
    expect((await call(dir, { agentProfileId: 'ap_o' })).r).toMatchObject({ sandbox: false })
  })

  it('a profile that is not found is null, with one log line', async () => {
    const dir = await profileDir([P()])
    const { r, logs } = await call(dir, { agentProfileId: 'ap_gone' })
    expect(r).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('ap_gone')
  })

  it('a store that cannot be read is null, with one log line', async () => {
    const dir = await profileDir()
    await fs.writeFile(profilePaths(dir).agentProfiles, '{ damaged')
    const { r, logs } = await call(dir, { agentProfileId: 'ap_000000000001' })
    expect(r).toBeNull()
    expect(logs).toHaveLength(1)
  })

  it('a damaged settings file still refuses an inherit profile\'s spawn', async () => {
    const dir = await profileDir([P({ permission: 'inherit' })])
    await expect(profileSpawn({
      profileDir: dir,
      agentProfileId: 'ap_000000000001',
      appWideYolo: async () => { throw new RepairNeeded('app-settings.json is damaged', 'app-settings.json') },
      log: () => {}
    })).rejects.toBeInstanceOf(RepairNeeded)
  })
})

// Task 8 fix round 1 (minor 5): the app's spawn path. A picked profile that no longer resolves at Start must leave the
// session with the app-wide mode, as a spawn without a profile gets from the dialog, not with no bypass at all (ask).
describe('appProfileSpawn', () => {
  const call = async (dir: string, over: { agentProfileId: string; bypassPermissions?: boolean; yolo: boolean }) =>
    appProfileSpawn({
      profileDir: dir,
      agentProfileId: over.agentProfileId,
      ...(over.bypassPermissions !== undefined ? { bypassPermissions: over.bypassPermissions } : {}),
      appWideYolo: async () => over.yolo,
      log: () => {}
    })

  it('a profile that resolves gives its id and permission', async () => {
    const dir = await profileDir([P({ id: 'ap_a', permission: 'ask' })])
    expect(await call(dir, { agentProfileId: 'ap_a', yolo: true })).toEqual({ agentProfileId: 'ap_a', bypassPermissions: false, sandbox: false })
  })

  it('a sandboxed profile that resolves gives its sandbox', async () => {
    const dir = await profileDir([P({ id: 'ap_s', sandbox: true })])
    expect(await call(dir, { agentProfileId: 'ap_s', yolo: false })).toEqual({ agentProfileId: 'ap_s', bypassPermissions: false, sandbox: true })
  })

  it('a profile that does not resolve falls back to the app-wide mode, with no id', async () => {
    const dir = await profileDir([P()])
    expect(await call(dir, { agentProfileId: 'ap_gone', yolo: true })).toEqual({ bypassPermissions: true })
    expect(await call(dir, { agentProfileId: 'ap_gone', yolo: false })).toEqual({ bypassPermissions: false })
  })

  it('a damaged store falls back to the app-wide mode too', async () => {
    const dir = await profileDir()
    await fs.writeFile(profilePaths(dir).agentProfiles, '{ damaged')
    expect(await call(dir, { agentProfileId: 'ap_000000000001', yolo: true })).toEqual({ bypassPermissions: true })
  })

  it('an explicit value from the caller still wins when the profile does not resolve', async () => {
    const dir = await profileDir()
    expect(await call(dir, { agentProfileId: 'ap_gone', bypassPermissions: false, yolo: true })).toEqual({ bypassPermissions: false })
  })
})
