// Agent Profiles follow-up: a transcript does not say which agent profile ran it, so the app writes down, by the
// provider's own conversation id, the profile of the session that ran it, and a history resume reads it back. A
// profile gone since, or a file that cannot be read, resumes without one (design §5). Bounded, versioned, under the
// profile root.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { profilePaths } from '../profile/paths'
import { writeAgentProfiles } from './store'
import type { AgentProfile } from './types'
import { PROFILE_CONVERSATIONS_MAX, profileConversations } from './conversations'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profileDir = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-agentconv-'))
  dirs.push(d)
  return d
}

const P = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'ap_1', name: 'Reviewer', status: 'active', accountIds: ['acc_1'], mcpExclude: [], permission: 'inherit',
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', ...over
})

const setup = async (profiles: AgentProfile[] = [P(), P({ id: 'ap_2', name: 'Other' })]) => {
  const dir = await profileDir()
  await writeAgentProfiles(dir, { version: 1, profiles })
  let t = Date.parse('2026-10-22T10:00:00.000Z')
  const logs: string[] = []
  const tick = (): void => {
    t += 1000
  }
  const sessionProfiles: Record<string, string> = { 'sess-profiled': 'ap_1' }
  const c = profileConversations({ profileDir: dir, now: () => t, log: (l) => logs.push(l), profileOfSession: (id) => sessionProfiles[id] })
  const file = profilePaths(dir).agentProfileConversations
  const onDisk = async (): Promise<{ version: number; conversations: Record<string, { agentProfileId: string; at: string }> }> =>
    JSON.parse(await fs.readFile(file, 'utf8'))
  return { dir, c, file, onDisk, logs, tick }
}

describe('the conversations agent profiles ran', () => {
  it('records a conversation’s profile by its id and finds it again, in a versioned file under the profile', async () => {
    const { c, file, onDisk } = await setup()
    await c.record('conv-claude', 'ap_1')
    await c.record('thread-codex', 'ap_2')
    expect(await c.profileOf('conv-claude')).toBe('ap_1')
    expect(await c.profileOf('thread-codex')).toBe('ap_2')
    expect(await c.profileOf('conv-unknown')).toBeNull()
    expect(path.basename(file)).toBe('agent-profile-conversations.json')
    expect(await onDisk()).toEqual({
      version: 1,
      conversations: {
        'conv-claude': { agentProfileId: 'ap_1', at: '2026-10-22T10:00:00.000Z' },
        'thread-codex': { agentProfileId: 'ap_2', at: '2026-10-22T10:00:00.000Z' }
      }
    })
  })

  // What the app's three sources call (a Claude hook payload, a Codex rollout's thread, a chat's ready): the session's
  // own profile is recorded, and a session without one, or an id not learned yet, records nothing
  it('a session that learned its conversation records it with the profile it runs as', async () => {
    const { c, file } = await setup()
    await c.learned('sess-plain', 'conv-plain')
    await c.learned('sess-profiled', null)
    await c.learned('sess-profiled', '')
    await expect(fs.stat(file)).rejects.toThrow()
    await c.learned('sess-profiled', 'conv-1')
    expect(await c.profileOf('conv-1')).toBe('ap_1')
    expect(await c.profileOf('conv-plain')).toBeNull()
  })

  it('finds nothing before anything is recorded', async () => {
    const { c } = await setup()
    expect(await c.profileOf('conv-1')).toBeNull()
  })

  // Every hook event of a Claude session names its conversation: the same pair is written once, and a later profile for
  // the same conversation (resumed as another) replaces the earlier
  it('writes the same pair once, and a new profile for the conversation over the old', async () => {
    const { c, onDisk, tick } = await setup()
    await c.record('conv-1', 'ap_1')
    tick()
    await c.record('conv-1', 'ap_1')
    expect((await onDisk()).conversations['conv-1']).toEqual({ agentProfileId: 'ap_1', at: '2026-10-22T10:00:00.000Z' })
    await c.record('conv-1', 'ap_2')
    expect((await onDisk()).conversations['conv-1']).toEqual({ agentProfileId: 'ap_2', at: '2026-10-22T10:00:01.000Z' })
    expect(await c.profileOf('conv-1')).toBe('ap_2')
  })

  it('records many at once without losing one', async () => {
    const { c } = await setup()
    await Promise.all(Array.from({ length: 20 }, (_, i) => c.record(`conv-${i}`, i % 2 === 0 ? 'ap_1' : 'ap_2')))
    for (let i = 0; i < 20; i++) expect(await c.profileOf(`conv-${i}`), String(i)).toBe(i % 2 === 0 ? 'ap_1' : 'ap_2')
  })

  // design §5: a profile deleted since resumes without one; an archived one still resolves, as work that holds it does
  it('finds a profile only while the profile store still has it, archived included', async () => {
    const { dir, c } = await setup()
    await c.record('conv-1', 'ap_1')
    await c.record('conv-2', 'ap_2')
    await writeAgentProfiles(dir, { version: 1, profiles: [P({ status: 'archived' })] })
    expect(await c.profileOf('conv-1')).toBe('ap_1')
    expect(await c.profileOf('conv-2')).toBeNull()
    await fs.writeFile(profilePaths(dir).agentProfiles, '{ not json')
    expect(await c.profileOf('conv-1')).toBeNull()
  })

  it(`keeps the ${PROFILE_CONVERSATIONS_MAX} most recently learned`, async () => {
    const { c, onDisk, tick } = await setup()
    for (let i = 0; i < PROFILE_CONVERSATIONS_MAX + 3; i++) {
      await c.record(`conv-${i}`, 'ap_1')
      tick()
    }
    const kept = Object.keys((await onDisk()).conversations)
    expect(kept).toHaveLength(PROFILE_CONVERSATIONS_MAX)
    expect(kept).not.toContain('conv-0')
    expect(kept).not.toContain('conv-2')
    expect(kept).toContain('conv-3')
    expect(kept).toContain(`conv-${PROFILE_CONVERSATIONS_MAX + 2}`)
  })

  // A memory of conveniences: damage is kept aside and the file started afresh by the next record, never by a read
  it('a damaged file finds nothing, and the next record keeps it aside and starts afresh', async () => {
    const { c, file, onDisk } = await setup()
    await fs.writeFile(file, '{ not json')
    expect(await c.profileOf('conv-1')).toBeNull()
    const bak = async (): Promise<string[]> => (await fs.readdir(path.dirname(file))).filter((f) => f.startsWith('agent-profile-conversations.json.') && f.endsWith('.bak'))
    expect(await bak()).toHaveLength(0)
    await c.record('conv-1', 'ap_1')
    expect(await bak()).toHaveLength(1)
    expect((await onDisk()).conversations).toEqual({ 'conv-1': { agentProfileId: 'ap_1', at: '2026-10-22T10:00:00.000Z' } })
  })

  it('never rejects: a record that cannot be written is logged and the caller goes on', async () => {
    const { dir, c, logs } = await setup()
    // A folder where the file should be: neither readable as the store nor writable over
    await fs.mkdir(profilePaths(dir).agentProfileConversations)
    await expect(c.record('conv-1', 'ap_1')).resolves.toBeUndefined()
    expect(logs.some((l) => l.includes('conv-1'))).toBe(true)
    expect(await c.profileOf('conv-1')).toBeNull()
  })
})
