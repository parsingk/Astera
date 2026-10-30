// The Host's `agent-profiles-audit*` commands (lifecycle design §6, §7, §8): the findings computed from what the Host
// reads, a source that cannot be read named rather than taken for empty (Review Focus 1), one report a minute (Review
// Focus 5), the ignore file, and who may ask.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The readers, watched: a request the cache answers reads nothing, and the records are streamed once, never queried
vi.mock('../../core/audit/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/audit/store')>()
  return { ...real, visitRecords: vi.fn(real.visitRecords), queryRecords: vi.fn(real.queryRecords) }
})
vi.mock('../../core/agentProfiles/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/agentProfiles/store')>()
  return { ...real, readAgentProfiles: vi.fn(real.readAgentProfiles) }
})
vi.mock('../../core/findings/ignored', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/findings/ignored')>()
  return { ...real, readIgnored: vi.fn(real.readIgnored) }
})

import { auditDayOf, queryRecords, visitRecords } from '../../core/audit/store'
import { readAgentProfiles } from '../../core/agentProfiles/store'
import { readIgnored } from '../../core/findings/ignored'
import { profilePaths } from '../../core/profile/paths'
import { STARTER_POLICY } from '../../core/audit/policy'
import { emptyState } from '../../core/orchestration/state'
import type { RuntimeProfile } from '../../core/runtimes/registry'
import type { Account } from '../../core/types'
import { RULES, type RuleSource } from '../../core/findings/compute'
import type { Finding } from '../../core/findings/types'
import { FINDINGS_COMMANDS, createHostFindings, gatherFindings, type FindingsDeps } from './commands'

const NOW = Date.parse('2026-10-30T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (ms: number): string => new Date(ms).toISOString()

let dir: string
let clock: number
let logs: string[]
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-findings-'))
  clock = NOW
  logs = []
  vi.clearAllMocks()
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** A Runtime last reached 40 days ago: §4.7's finding, which reads no profile. */
const STALE: RuntimeProfile = {
  runtimeId: 'rt_old',
  name: 'lab',
  address: '10.0.0.2',
  port: 7000,
  fingerprint: 'f',
  permission: 'read-only',
  createdAt: iso(NOW - 60 * DAY),
  lastSeenAt: iso(NOW - 40 * DAY)
}
const KEY = 'stale-runtime:rt_old'

/** A Host's readers over the temp profile, each call named in `calls`. */
const deps = (over: Partial<FindingsDeps> = {}) => {
  const calls: string[] = []
  const d: FindingsDeps = {
    profileDir: dir,
    homeDir: dir,
    platform: 'linux',
    nowMs: () => clock,
    orchState: () => (calls.push('orchestration'), emptyState()),
    spent: () => (calls.push('tokens'), []),
    appBypass: async () => (calls.push('settings'), false),
    readAccounts: async () => (calls.push('accounts'), []),
    openRuntimes: async () => (calls.push('runtimes'), [STALE]),
    claudeVersion: async () => (calls.push('cli-version'), null),
    log: (m) => logs.push(m),
    ...over
  }
  return { d, calls }
}

const marks = () => ({ effects: 0 })
type Host = ReturnType<typeof createHostFindings>
const audit = (h: Host, args: Record<string, unknown> = {}, m = marks()) => h.command({ cmd: 'agent-profiles-audit', args, role: 'cli', marks: m })
const ignore = (h: Host, args: Record<string, unknown>, m = marks()) => h.command({ cmd: 'agent-profiles-audit-ignore', args, role: 'app', marks: m })
const unignore = (h: Host, args: Record<string, unknown>, m = marks()) => h.command({ cmd: 'agent-profiles-audit-unignore', args, role: 'app', marks: m })
const body = (r: { body: unknown }) => r.body as { findings: Array<Record<string, unknown>>; info: unknown[]; observe: unknown; unread: string[]; computedAt: string }
const keysOf = (r: { body: unknown }): string[] => body(r).findings.map((f) => f.key as string)

describe('the findings commands', () => {
  it('names its three commands', () => {
    expect([...FINDINGS_COMMANDS].sort()).toEqual(['agent-profiles-audit', 'agent-profiles-audit-ignore', 'agent-profiles-audit-unignore'])
  })

  it('answers 200 with a report on an empty profile: no findings, observe off, unread empty', async () => {
    const r = await audit(createHostFindings(deps({ openRuntimes: async () => [] }).d))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ findings: [], info: [], observe: { on: false, days: 0 }, unread: [], computedAt: iso(NOW) })
    // The history stamp is written by the first compute (ruling 2)
    expect(JSON.parse(await fs.readFile(profilePaths(dir).findingsHistory, 'utf8'))).toEqual({ version: 1, since: iso(NOW) })
  })

  // Review Focus 1: the profile findings go, the section names the source, and the Runtime's finding stays
  it('a damaged agent-profiles.json drops the profile findings, names profiles in unread, keeps the runtime finding', async () => {
    await fs.writeFile(profilePaths(dir).agentProfiles, '{ not json')
    const r = await audit(createHostFindings(deps().d))
    expect(r.status).toBe(200)
    expect(body(r).unread).toEqual(['profiles'])
    expect(keysOf(r)).toEqual([KEY])
    expect(logs.filter((l) => l.startsWith('findings: profiles could not be read'))).toHaveLength(1)
  })

  it('names every other source it could not read, each on its own', async () => {
    // The Rules file, the ignore file, an account's own MCP servers and what the Host holds
    await fs.writeFile(profilePaths(dir).auditPolicy, '{ damaged')
    await fs.writeFile(profilePaths(dir).findingsIgnored, '{ damaged')
    const configDir = path.join(dir, 'acc1')
    await fs.mkdir(configDir)
    // Text a parse error would quote: the log names the account, never what its file holds
    await fs.writeFile(path.join(configDir, '.claude.json'), 'sk-live-0123456789')
    const account: Account = { id: 'acc1', label: 'one', configDir, color: '#000', createdAt: iso(NOW - 100 * DAY), provider: 'claude' }
    const { d } = deps({
      readAccounts: async () => [account],
      orchState: () => null,
      claudeVersion: async () => {
        throw new Error('probe failed')
      },
      appBypass: async () => {
        throw new Error('app-settings.json is damaged')
      }
    })
    const r = await audit(createHostFindings(d))
    expect(r.status).toBe(200)
    expect(body(r).unread).toEqual(['orchestration', 'policy', 'account-mcp', 'settings', 'cli-version', 'ignored'])
    // Never "Observe is off" on a policy that could not be read: the unread line says it (FindingsReport.observe)
    expect(body(r).observe).toEqual({ on: false, days: 0 })
    // With the ignore file unread, every finding shows open
    expect(body(r).findings.map((f) => [f.key, f.ignored])).toEqual([[KEY, false]])
    for (const source of ['orchestration', 'policy', 'account-mcp', 'settings', 'cli-version', 'ignored'])
      expect(logs.filter((l) => l.startsWith(`findings: ${source} could not be read`)), source).toHaveLength(1)
    expect(logs.find((l) => l.startsWith('findings: account-mcp'))).toMatch(/acc1/)
    expect(logs.join('\n')).not.toContain('sk-live')
  })

  // Ruling R7-1: a rule that cannot read an entry costs its own findings, and the report still answers
  it('a rule that throws drops only its own findings: 200, the others kept, its sources named, one log line', async () => {
    const failing = {
      name: 'failing-row',
      needs: ['profiles'] as RuleSource[],
      run: (): Finding[] => {
        throw new TypeError("Cannot read properties of undefined (reading 'join')")
      }
    }
    RULES.push(failing)
    try {
      const r = await audit(createHostFindings(deps().d))
      expect(r.status).toBe(200)
      expect(keysOf(r)).toEqual([KEY])
      expect(body(r).unread).toEqual(['profiles'])
      expect(logs.filter((l) => l.includes('rule failed'))).toEqual([
        "findings: the failing-row rule failed, so its findings are left out (Cannot read properties of undefined (reading 'join'))"
      ])
    } finally {
      RULES.splice(RULES.indexOf(failing), 1)
    }
  })

  it('a profile entry the store keeps but a rule cannot read still answers 200 with the rest', async () => {
    await fs.writeFile(profilePaths(dir).agentProfiles, JSON.stringify({ version: 1, profiles: [{ id: 'ap_bad' }] }))
    const r = await audit(createHostFindings(deps().d))
    expect(r.status).toBe(200)
    expect(keysOf(r)).toContain(KEY)
    expect(body(r).unread).toContain('profiles')
    expect(logs.some((l) => l.includes('rule failed'))).toBe(true)
  })

  it('logs a parse error without the text it quotes', async () => {
    const { d } = deps({
      openRuntimes: async () => {
        throw new SyntaxError('Unexpected token \'t\', "token-abc" is not valid JSON')
      }
    })
    const r = await audit(createHostFindings(d))
    expect(body(r).unread).toEqual(['runtimes'])
    expect(logs).toContain('findings: runtimes could not be read (it did not parse)')
    expect(logs.join('\n')).not.toContain('token-abc')
  })

  // Rulings R4-4 and R6-7: a day of a use log that stopped at the size inside the window is missing data
  it('a use log day that stopped at the size inside the window makes that log unread; one older is not', async () => {
    const stop = async (folder: string, ms: number): Promise<void> => {
      await fs.mkdir(folder, { recursive: true })
      await fs.writeFile(path.join(folder, `${auditDayOf(iso(ms))}.jsonl`), '')
      await fs.writeFile(path.join(folder, `${auditDayOf(iso(ms))}.stopped`), '')
    }
    await stop(profilePaths(dir).credentialUses, NOW - 3 * DAY)
    await stop(profilePaths(dir).extensionUses, NOW - 40 * DAY)
    const first = await gatherFindings(deps().d, NOW)
    expect(first.inputs.credentialLastUse).toBeUndefined()
    expect(first.inputs.extensionUses).toBeDefined()
    await stop(profilePaths(dir).extensionUses, NOW - 2 * DAY)
    const second = await gatherFindings(deps().d, NOW)
    expect(second.inputs.extensionUses).toBeUndefined()
    expect(second.inputs.extensionCopies).toBeUndefined()
  })

  it('reads the Observe history from the policy, the history stamp and the stopped days', async () => {
    await fs.writeFile(profilePaths(dir).auditPolicy, JSON.stringify({ ...STARTER_POLICY, mode: 'observe', observingSince: iso(NOW - 12 * DAY) }))
    await fs.writeFile(profilePaths(dir).findingsHistory, JSON.stringify({ version: 1, since: iso(NOW - 40 * DAY) }))
    await fs.mkdir(profilePaths(dir).auditRecords, { recursive: true })
    await fs.writeFile(path.join(profilePaths(dir).auditRecords, `${auditDayOf(iso(NOW - 5 * DAY))}.stopped`), '')
    const r = await audit(createHostFindings(deps().d))
    expect(body(r).observe).toEqual({ on: true, days: 11 })
    expect(body(r).unread).toEqual([])
  })

  it('takes the latest credential use of each entry in the window', async () => {
    const folder = profilePaths(dir).credentialUses
    await fs.mkdir(folder, { recursive: true })
    const use = (id: string, entryId: string, ms: number) =>
      JSON.stringify({ id, at: iso(ms), actor: 'session', entryId, provider: 'mcp', action: 'mcp.call', resource: 'linear/x', outcome: 'ok', evidence: 'managed', requestId: 'r' })
    await fs.writeFile(path.join(folder, `${auditDayOf(iso(NOW - 2 * DAY))}.jsonl`), [use('cu_1', 'mcp:m1', NOW - 2 * DAY), use('cu_2', 'mcp:m2', NOW - 2 * DAY - 1000)].join('\n') + '\n')
    await fs.writeFile(path.join(folder, `${auditDayOf(iso(NOW - 1 * DAY))}.jsonl`), use('cu_3', 'mcp:m1', NOW - DAY) + '\n')
    // Older than the window: not a use of it
    await fs.writeFile(path.join(folder, `${auditDayOf(iso(NOW - 30 * DAY - 1000))}.jsonl`), use('cu_4', 'mcp:m3', NOW - 30 * DAY - 1000) + '\n')
    const { inputs } = await gatherFindings(deps().d, NOW)
    expect(inputs.credentialLastUse).toEqual(new Map([['mcp:m1', iso(NOW - DAY)], ['mcp:m2', iso(NOW - 2 * DAY - 1000)]]))
  })

  // Review Focus 5
  it('a second request within 60 seconds reads no file', async () => {
    const { d, calls } = deps()
    const h = createHostFindings(d)
    await audit(h)
    const read = () => [calls.length, vi.mocked(readAgentProfiles).mock.calls.length, vi.mocked(visitRecords).mock.calls.length, vi.mocked(readIgnored).mock.calls.length]
    const once = read()
    expect(once.every((n) => n > 0)).toBe(true)
    clock = NOW + 59_999
    const again = await audit(h)
    expect(read()).toEqual(once)
    expect(body(again).computedAt).toBe(iso(NOW))
    clock = NOW + 60_000
    const later = await audit(h)
    expect(body(later).computedAt).toBe(iso(NOW + 60_000))
    expect(vi.mocked(visitRecords).mock.calls.length).toBe(once[2] + 1)
  })

  // Ruling R8-1: any change the Host answered (an archive, an edit, a rule) drops the report, so a mark or the section
  // never shows a minute of what was just changed
  it('forget drops the report: the next audit within the minute computes afresh', async () => {
    const h = createHostFindings(deps().d)
    await audit(h)
    const once = vi.mocked(readAgentProfiles).mock.calls.length
    clock = NOW + 1_000
    h.forget()
    const again = await audit(h)
    expect(vi.mocked(readAgentProfiles).mock.calls.length).toBe(once + 1)
    expect(body(again).computedAt).toBe(iso(NOW + 1_000))
    // And it is kept again from there
    clock = NOW + 2_000
    expect(body(await audit(h)).computedAt).toBe(iso(NOW + 1_000))
  })

  it('two requests at once share one compute', async () => {
    const h = createHostFindings(deps().d)
    const [a, b] = await Promise.all([audit(h), audit(h)])
    expect(a.body).toEqual(b.body)
    expect(vi.mocked(readAgentProfiles)).toHaveBeenCalledTimes(1)
  })

  it('the record window is read once with visitRecords and no record array is kept', async () => {
    const folder = profilePaths(dir).auditRecords
    await fs.mkdir(folder, { recursive: true })
    const rec = (n: number, ms: number) =>
      JSON.stringify({
        id: `ar_${n}`,
        at: iso(ms),
        sessionId: 's',
        provider: 'claude',
        kind: 'terminal',
        accountId: 'acc1',
        agentProfileId: 'ap_x',
        source: 'hook',
        providerTool: n % 2 === 0 ? 'Read' : 'mcp__github__get_issue',
        action: n % 2 === 0 ? 'filesystem.read' : 'mcp.call',
        target: n % 2 === 0 ? 'a.ts' : 'github.get_issue',
        insideProject: true,
        confidence: 'high',
        effect: 'read',
        status: 'ok'
      })
    for (const [first, ms] of [[0, NOW - 2 * DAY], [2500, NOW - DAY]] as const) {
      const lines = Array.from({ length: 2500 }, (_, i) => rec(first + i, ms + i))
      await fs.writeFile(path.join(folder, `${auditDayOf(iso(ms))}.jsonl`), lines.join('\n') + '\n')
    }
    // Older than the window: not counted
    await fs.writeFile(path.join(folder, `${auditDayOf(iso(NOW - 31 * DAY))}.jsonl`), rec(9999, NOW - 31 * DAY) + '\n')
    const { inputs } = await gatherFindings(deps().d, NOW)
    expect(inputs.observed?.byProfile.get('ap_x')).toEqual({ calls: 5000, allRead: true, stayedInFolder: true, mcpServers: new Set(['github']) })
    expect(inputs.observed?.mcpServers).toEqual(new Set(['github']))
    expect(vi.mocked(visitRecords)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(queryRecords)).not.toHaveBeenCalled()
  })

  it('ignore then audit: the finding is left out; with all it is there with ignored true and the note', async () => {
    const h = createHostFindings(deps().d)
    expect(await ignore(h, { key: KEY, note: 'the lab is shut until spring' })).toEqual({ status: 200, body: { key: KEY } })
    expect(keysOf(await audit(h))).toEqual([])
    const all = await audit(h, { all: true })
    expect(body(all).findings).toEqual([expect.objectContaining({ key: KEY, ignored: true, ignoredAt: iso(NOW), note: 'the lab is shut until spring' })])
    expect(JSON.parse(await fs.readFile(profilePaths(dir).findingsIgnored, 'utf8'))).toEqual({
      version: 1,
      ignored: { [KEY]: { at: iso(NOW), note: 'the lab is shut until spring' } }
    })
  })

  it('ignore drops the cache, so the next audit reflects it, and so does unignore', async () => {
    const h = createHostFindings(deps().d)
    expect(keysOf(await audit(h))).toEqual([KEY])
    await ignore(h, { key: KEY })
    expect(keysOf(await audit(h))).toEqual([])
    expect(await unignore(h, { key: KEY })).toEqual({ status: 200, body: { key: KEY, removed: true } })
    expect(keysOf(await audit(h))).toEqual([KEY])
    expect(JSON.parse(await fs.readFile(profilePaths(dir).findingsIgnored, 'utf8'))).toEqual({ version: 1, ignored: {} })
  })

  it('ignore of a key no finding has is 404, and nothing is written', async () => {
    const r = await ignore(createHostFindings(deps().d), { key: 'stale-runtime:rt_gone' })
    expect(r.status).toBe(404)
    expect((r.body as { error: string }).error).toMatch(/stale-runtime:rt_gone/)
    await expect(fs.access(profilePaths(dir).findingsIgnored)).rejects.toThrow()
  })

  it('unignore of an unknown key is 200 removed false', async () => {
    const m = marks()
    expect(await unignore(createHostFindings(deps().d), { key: 'nope' }, m)).toEqual({ status: 200, body: { key: 'nope', removed: false } })
    expect(m.effects).toBe(0)
  })

  it('refuses arguments it cannot use', async () => {
    const h = createHostFindings(deps().d)
    expect((await audit(h, { all: 'yes' })).status).toBe(400)
    expect((await ignore(h, {})).status).toBe(400)
    expect((await ignore(h, { key: KEY, note: 'two\nlines' })).status).toBe(400)
    expect((await ignore(h, { key: KEY, note: 'x'.repeat(201) })).status).toBe(400)
    expect((await unignore(h, { key: '' })).status).toBe(400)
    await expect(fs.access(profilePaths(dir).findingsIgnored)).rejects.toThrow()
  })

  it('a damaged ignore file refuses ignore with 409 and keeps the file', async () => {
    await fs.writeFile(profilePaths(dir).findingsIgnored, '{ damaged')
    const r = await ignore(createHostFindings(deps().d), { key: KEY })
    expect(r.status).toBe(409)
    expect(await fs.readFile(profilePaths(dir).findingsIgnored, 'utf8')).toBe('{ damaged')
  })

  it("an agent's shell may audit and is refused ignore with its agentRefusal", async () => {
    const h = createHostFindings(deps().d)
    const agent = { role: 'cli' as const, agentRefusal: 'not from an agent session', marks: marks() }
    expect((await h.command({ cmd: 'agent-profiles-audit', args: {}, ...agent })).status).toBe(200)
    for (const cmd of ['agent-profiles-audit-ignore', 'agent-profiles-audit-unignore'])
      expect(await h.command({ cmd, args: { key: KEY }, ...agent }), cmd).toEqual({ status: 403, body: { error: 'not from an agent session' } })
    await expect(fs.access(profilePaths(dir).findingsIgnored)).rejects.toThrow()
  })

  it('an mcp or plugin role is refused all three', async () => {
    const h = createHostFindings(deps().d)
    for (const role of ['mcp', 'plugin', 'controller', undefined] as const)
      for (const cmd of FINDINGS_COMMANDS)
        expect(await h.command({ cmd, args: { key: KEY }, role, marks: marks() }), `${String(role)} ${cmd}`).toEqual({
          status: 403,
          body: { error: `${cmd} is for this machine's app and CLI only` }
        })
  })

  it('the audit-ignore change counts one effect, audit counts none', async () => {
    const h = createHostFindings(deps().d)
    const read = marks()
    await audit(h, {}, read)
    expect(read.effects).toBe(0)
    const ignored = marks()
    await ignore(h, { key: KEY }, ignored)
    expect(ignored.effects).toBe(1)
    const brought = marks()
    await unignore(h, { key: KEY }, brought)
    expect(brought.effects).toBe(1)
  })
})
