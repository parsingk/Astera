// The §4.12 use log (lifecycle design §4.12): each use of a skill, command or agent Claude Code reported exactly, and the
// mark of a Claude chat that ran, in day files of their own beside the tool calls, kept and pruned as they are, and summed
// up for a window as the names used.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { profilePaths } from '../profile/paths'
import { pruneRecords } from './store'
import { appendExtensionUses, summarizeExtensionUses, type ExtensionUse } from './extensionUses'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-extuses-'))
  dirs.push(d)
  return d
}

/** Noon, local time, so the day a use is filed under is the day it names here. */
const at = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12).toISOString()
}
const ms = (day: string): number => Date.parse(at(day))
const DAY = 24 * 60 * 60 * 1000

let n = 0
const use = (via: ExtensionUse['via'], name: string, day: string, over: Partial<ExtensionUse> = {}): ExtensionUse => ({
  id: `eu_${String(++n).padStart(16, '0')}`,
  at: at(day),
  sessionId: 'sess_a',
  provider: 'claude',
  kind: 'terminal',
  accountId: 'acc1',
  via,
  name,
  ...over
})

describe('the extension use log', () => {
  it('append and summarize within the window', async () => {
    const p = await profile()
    const now = ms('2026-10-30')
    await appendExtensionUses(p, [use('skill-tool', 'review', '2026-10-29'), use('slash', 'ship', '2026-10-20', { kind: 'chat', agentProfileId: 'ap1' })], { now: () => now })
    await appendExtensionUses(p, [use('subagent', 'Code Reviewer', '2026-10-28'), use('agent-tool', 'code-reviewer', '2026-10-28'), use('slash', 'p:x', '2026-10-28')], { now: () => now })
    expect((await fs.readdir(profilePaths(p).extensionUses)).sort()).toEqual(['2026-10-20.jsonl', '2026-10-28.jsonl', '2026-10-29.jsonl'])
    const s = await summarizeExtensionUses(p, now - 30 * DAY, now)
    // As reported: the mapping to the registry is the rule's
    expect([...s.skillOrCommand].sort()).toEqual(['p:x', 'review', 'ship'])
    expect([...s.agents].sort()).toEqual(['Code Reviewer', 'code-reviewer'])
    expect(s.claudeChatSeen).toBe(false)
    // A line that is not a use is passed by
    await fs.appendFile(path.join(profilePaths(p).extensionUses, '2026-10-29.jsonl'), 'not json\n{"id":"eu_x"}\n')
    expect([...(await summarizeExtensionUses(p, now - 30 * DAY, now)).skillOrCommand].sort()).toEqual(['p:x', 'review', 'ship'])
  })

  it('a use older than the window is not in the summary', async () => {
    const p = await profile()
    const now = ms('2026-10-30')
    await appendExtensionUses(p, [use('skill-tool', 'old', '2026-10-05'), use('subagent', 'old-agent', '2026-10-05'), use('slash', 'new', '2026-10-25')], { now: () => now })
    const s = await summarizeExtensionUses(p, ms('2026-10-10'), now)
    expect([...s.skillOrCommand]).toEqual(['new'])
    expect([...s.agents]).toEqual([])
    // No folder yet: nothing used, not an error
    const empty = await summarizeExtensionUses(await profile(), now - 30 * DAY, now)
    expect([empty.skillOrCommand.size, empty.agents.size]).toEqual([0, 0])
  })

  // Ruling R6-1: a Claude chat's first stream line is marked, so a chat that made no call still counts as one that ran
  it('a Claude chat mark in the window says a chat ran, and names nothing', async () => {
    const p = await profile()
    const now = ms('2026-10-30')
    await appendExtensionUses(p, [use('chat-seen', '', '2026-10-05', { kind: 'chat' })], { now: () => now })
    expect((await summarizeExtensionUses(p, ms('2026-10-10'), now)).claudeChatSeen).toBe(false)
    await appendExtensionUses(p, [use('chat-seen', '', '2026-10-25', { kind: 'chat' })], { now: () => now })
    const s = await summarizeExtensionUses(p, ms('2026-10-10'), now)
    expect(s.claudeChatSeen).toBe(true)
    expect([s.skillOrCommand.size, s.agents.size]).toEqual([0, 0])
  })

  it('pruned with the same keep days as the records', async () => {
    const p = await profile()
    const dir = profilePaths(p).extensionUses
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, '2026-09-20.jsonl'), '\n')
    await fs.writeFile(path.join(dir, '2026-10-22.jsonl'), '\n')
    await pruneRecords(p, { now: () => ms('2026-10-23') })
    expect((await fs.readdir(dir)).sort()).toEqual(['2026-10-22.jsonl'])
  })
})
