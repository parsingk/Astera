// The window's records summed up once (lifecycle design §4.5, §4.10, Review Focus 5): which MCP servers were called, and
// per profile how many calls, whether all of them read, and whether they stayed in the session's folder. The two flags
// start true and only ever turn false, and a record that cannot say turns them false (never on missing data).
import { describe, it, expect } from 'vitest'
import type { AuditRecord } from '../audit/types'
import { addRecord, emptyUse, mcpNameMatches } from './usage'

let n = 0
/** A read inside the folder by profile ap_a, with every field this release records. */
const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: `ar_${++n}`,
  at: '2026-10-29T00:00:00.000Z',
  sessionId: 's_1',
  provider: 'claude',
  kind: 'terminal',
  accountId: 'acc_1',
  agentProfileId: 'ap_a',
  source: 'claude-hook',
  providerTool: 'Read',
  action: 'filesystem.read',
  target: 'a.ts',
  insideProject: true,
  confidence: 'exact',
  effect: 'read',
  status: 'ok',
  ...over
})

const useOf = (...records: AuditRecord[]) => {
  const u = emptyUse()
  for (const r of records) addRecord(u, r)
  return u
}

describe('the Observe usage summary', () => {
  it('starts empty', () => {
    const u = emptyUse()
    expect(u.byProfile.size).toBe(0)
    expect(u.mcpServers.size).toBe(0)
  })

  it('mcp servers are collected from targets', () => {
    const mcp = (target: string, agentProfileId?: string): AuditRecord =>
      rec({ action: 'mcp.call', target, providerTool: `mcp__${target.replace('.', '__')}`, effect: 'unknown', insideProject: undefined, agentProfileId })
    const u = useOf(mcp('github.create_issue', 'ap_a'), mcp('linear.list.issues', 'ap_a'), mcp('browser.open'))
    // The server part is what sits before the first dot; a tool name may hold dots of its own
    expect([...u.mcpServers].sort()).toEqual(['browser', 'github', 'linear'])
    expect([...u.byProfile.get('ap_a')!.mcpServers].sort()).toEqual(['github', 'linear'])
    // A record with no profile counts for the servers only
    expect([...u.byProfile.keys()]).toEqual(['ap_a'])
    expect(u.byProfile.get('ap_a')!.calls).toBe(2)
  })

  it('counts each profile apart, and keeps both flags while every record reads inside the folder', () => {
    const u = useOf(rec(), rec(), rec({ agentProfileId: 'ap_b' }))
    expect(u.byProfile.get('ap_a')).toEqual({ calls: 2, allRead: true, stayedInFolder: true, mcpServers: new Set() })
    expect(u.byProfile.get('ap_b')).toMatchObject({ calls: 1, allRead: true, stayedInFolder: true })
  })

  it('a record without effect turns allRead and stayedInFolder false', () => {
    // A record an earlier release wrote: it cannot say what it did
    const u = useOf(rec(), rec({ effect: undefined }), rec())
    expect(u.byProfile.get('ap_a')).toMatchObject({ calls: 3, allRead: false, stayedInFolder: false })
  })

  it('an unknown effect turns allRead false, and stayedInFolder too when it ran outside the folder (ruling R2-2)', () => {
    const inside = useOf(rec({ action: 'process.execute', effect: 'unknown', insideProject: true }))
    expect(inside.byProfile.get('ap_a')).toMatchObject({ allRead: false, stayedInFolder: true })
    const unplaced = useOf(rec({ action: 'mcp.call', target: 'github.x', effect: 'unknown', insideProject: undefined }))
    expect(unplaced.byProfile.get('ap_a')).toMatchObject({ allRead: false, stayedInFolder: true })
    // It may have written outside the folder
    const outside = useOf(rec({ action: 'process.execute', effect: 'unknown', insideProject: false }))
    expect(outside.byProfile.get('ap_a')).toMatchObject({ allRead: false, stayedInFolder: false })
    // The same for one command of a line
    const line = useOf(
      rec({
        action: 'filesystem.read',
        effect: 'unknown',
        confidence: 'heuristic',
        commands: [{ action: 'filesystem.read', insideProject: true }, { action: 'process.execute', insideProject: false }]
      })
    )
    expect(line.byProfile.get('ap_a')).toMatchObject({ allRead: false, stayedInFolder: false })
  })

  it('a write outside the folder turns stayedInFolder false, a read outside does not', () => {
    const readOutside = useOf(rec({ insideProject: false }))
    expect(readOutside.byProfile.get('ap_a')).toMatchObject({ allRead: true, stayedInFolder: true })
    const writeInside = useOf(rec({ action: 'filesystem.write', effect: 'write', insideProject: true }))
    expect(writeInside.byProfile.get('ap_a')).toMatchObject({ allRead: false, stayedInFolder: true })
    const writeOutside = useOf(rec({ action: 'filesystem.write', effect: 'write', insideProject: false }))
    expect(writeOutside.byProfile.get('ap_a')).toMatchObject({ allRead: false, stayedInFolder: false })
    // A file write the resolver could not place is not known to have stayed inside
    const writeUnplaced = useOf(rec({ action: 'filesystem.write', effect: 'write', insideProject: undefined }))
    expect(writeUnplaced.byProfile.get('ap_a')).toMatchObject({ stayedInFolder: false })
    // A command of a line that writes outside, though the line's headline reads inside
    const line = useOf(
      rec({
        effect: 'write',
        confidence: 'heuristic',
        commands: [{ action: 'filesystem.read', insideProject: true }, { action: 'filesystem.delete', insideProject: false }]
      })
    )
    expect(line.byProfile.get('ap_a')).toMatchObject({ stayedInFolder: false })
    const lineInside = useOf(
      rec({
        effect: 'write',
        confidence: 'heuristic',
        commands: [{ action: 'filesystem.read', insideProject: false }, { action: 'filesystem.write', insideProject: true }]
      })
    )
    expect(lineInside.byProfile.get('ap_a')).toMatchObject({ stayedInFolder: true })
  })

  // Ruling R4-2: a push, a pull request and a change on GitHub write to the network, not outside the folder; a local git
  // write is outside only when it was placed there; an install the resolver could not place may have gone anywhere
  it('a network write keeps stayedInFolder, placed or not, as a headline or as a command of a line', () => {
    for (const action of ['git.remote.write', 'github.pr.create', 'github.write'] as const) {
      for (const insideProject of [undefined, false]) {
        const headline = useOf(rec({ action, effect: 'write', insideProject }))
        expect(headline.byProfile.get('ap_a'), `${action} ${insideProject}`).toMatchObject({ allRead: false, stayedInFolder: true })
        const command = useOf(
          rec({
            effect: 'write',
            confidence: 'heuristic',
            commands: [{ action: 'filesystem.read', insideProject: true }, insideProject === undefined ? { action } : { action, insideProject }]
          })
        )
        expect(command.byProfile.get('ap_a'), `${action} ${insideProject} in a line`).toMatchObject({ stayedInFolder: true })
      }
    }
  })

  it('a local git write turns stayedInFolder false only when placed outside', () => {
    const unplaced = useOf(rec({ action: 'git.local.write', effect: 'write', insideProject: undefined }))
    expect(unplaced.byProfile.get('ap_a')).toMatchObject({ stayedInFolder: true })
    const inside = useOf(rec({ action: 'git.local.write', effect: 'write', insideProject: true }))
    expect(inside.byProfile.get('ap_a')).toMatchObject({ stayedInFolder: true })
    const outside = useOf(rec({ action: 'git.local.write', effect: 'write', insideProject: false }))
    expect(outside.byProfile.get('ap_a')).toMatchObject({ stayedInFolder: false })
    const lineUnplaced = useOf(rec({ effect: 'write', confidence: 'heuristic', commands: [{ action: 'filesystem.read', insideProject: true }, { action: 'git.local.write' }] }))
    expect(lineUnplaced.byProfile.get('ap_a')).toMatchObject({ stayedInFolder: true })
    const lineOutside = useOf(
      rec({ effect: 'write', confidence: 'heuristic', commands: [{ action: 'filesystem.read', insideProject: true }, { action: 'git.local.write', insideProject: false }] })
    )
    expect(lineOutside.byProfile.get('ap_a')).toMatchObject({ stayedInFolder: false })
  })

  it('an install the resolver could not place turns stayedInFolder false', () => {
    const unplaced = useOf(rec({ action: 'package.install', effect: 'write', insideProject: undefined }))
    expect(unplaced.byProfile.get('ap_a')).toMatchObject({ stayedInFolder: false })
    const inLine = useOf(rec({ effect: 'write', confidence: 'heuristic', commands: [{ action: 'filesystem.read', insideProject: true }, { action: 'package.install' }] }))
    expect(inLine.byProfile.get('ap_a')).toMatchObject({ stayedInFolder: false })
    const inside = useOf(rec({ action: 'package.install', effect: 'write', insideProject: true }))
    expect(inside.byProfile.get('ap_a')).toMatchObject({ stayedInFolder: true })
  })

  it('any sensitive value turns stayedInFolder false', () => {
    for (const sensitive of ['.ssh', 'gh', 'unknown']) {
      const u = useOf(rec(), rec({ sensitive }))
      expect(u.byProfile.get('ap_a'), sensitive).toMatchObject({ allRead: true, stayedInFolder: false })
    }
  })

  it('a flag once false stays false', () => {
    const u = useOf(rec({ effect: undefined }), rec(), rec())
    expect(u.byProfile.get('ap_a')).toMatchObject({ allRead: false, stayedInFolder: false })
  })

  // §4.12, Step 0: a skill or command typed into a Claude chat is not reported, so the summary says a chat ran
  it('notes a Claude chat session’s call, with or without a profile, and no other kind', () => {
    expect(emptyUse().claudeChatSeen).toBe(false)
    expect(useOf(rec(), rec({ provider: 'codex', kind: 'chat', source: 'codex-chat' })).claudeChatSeen).toBe(false)
    expect(useOf(rec(), rec({ kind: 'chat', source: 'claude-chat', agentProfileId: undefined })).claudeChatSeen).toBe(true)
  })
})

describe('mcpNameMatches', () => {
  it('is equal, or equal once each character outside letters, digits, _ and - is _', () => {
    expect(mcpNameMatches('github', 'github')).toBe(true)
    // Claude Code names a server's tools with the characters it allows (mcp__my_server__tool)
    expect(mcpNameMatches('my.server', 'my_server')).toBe(true)
    expect(mcpNameMatches('my server!', 'my_server_')).toBe(true)
    expect(mcpNameMatches('my-server_2', 'my-server_2')).toBe(true)
    expect(mcpNameMatches('github', 'gitlab')).toBe(false)
    expect(mcpNameMatches('my_server', 'my.server')).toBe(false)
    expect(mcpNameMatches('Github', 'github')).toBe(false)
  })
})
