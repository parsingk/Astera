// Observe mode's record store (design §8): the Host's append-only JSONL under `<profile>/audit/`, one file per local day,
// kept 30 days or 50 MB, whichever comes first. A write never fails the source (Review Focus 4).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { profilePaths } from '../profile/paths'
import {
  AUDIT_KEEP_DAYS,
  AUDIT_MAX_BYTES,
  AUDIT_PRUNE_EVERY_MS,
  AUDIT_READ_YIELD_EVERY,
  appendRecords,
  auditDayOf,
  auditStoppedAtLimit,
  keepPruning,
  pruneRecords,
  queryRecords as queryAt,
  visitRecords,
  type AuditFilter,
  type AuditRecord
} from './store'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-auditstore-'))
  dirs.push(d)
  return d
}

/** Noon, local time, so the day a record is filed under is the day it names here. */
const at = (day: string, minute = 0): string => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12, minute).toISOString()
}
const ms = (day: string): number => Date.parse(at(day))
/** Read as on the fixtures' own day, so the kept days (30 back from the read) hold them whenever the suite runs. */
const queryRecords = (p: string, f: AuditFilter, o: Parameters<typeof queryAt>[2] = { now: () => ms('2026-10-23') }) => queryAt(p, f, o)

let n = 0
const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: `au_${++n}`,
  at: at('2026-10-23'),
  sessionId: 'sess_a',
  provider: 'claude',
  kind: 'terminal',
  accountId: 'acc1',
  source: 'claude-hook',
  providerTool: 'Bash',
  action: 'git.remote.write',
  target: 'git push',
  confidence: 'high',
  status: 'ok',
  ...over
})

const auditDir = (p: string): string => profilePaths(p).auditRecords
const files = async (p: string): Promise<string[]> => (await fs.readdir(auditDir(p)).catch(() => [] as string[])).sort()

describe('appendRecords and queryRecords', () => {
  it('files each record under the local day it happened and reads them back newest first', async () => {
    const p = await profile()
    const a = rec({ at: at('2026-10-22', 1) })
    const b = rec({ at: at('2026-10-23', 1) })
    const c = rec({ at: at('2026-10-23', 2) })
    await appendRecords(p, [a, c], { now: () => ms('2026-10-23') })
    await appendRecords(p, [b], { now: () => ms('2026-10-23') })
    expect(await files(p)).toEqual(['2026-10-22.jsonl', '2026-10-23.jsonl'])
    expect((await queryRecords(p, {})).map((r) => r.id)).toEqual([c.id, b.id, a.id])
    expect(auditDayOf(at('2026-10-23'))).toBe('2026-10-23')
    // One JSON object per line, nothing else
    const text = await fs.readFile(path.join(auditDir(p), '2026-10-23.jsonl'), 'utf8')
    expect(text.split('\n')).toHaveLength(3)
    expect(JSON.parse(text.split('\n')[0])).toEqual(c)
  })

  it('orders by time a record written late, within its day and across a page (a Host catching up after a restart)', async () => {
    const p = await profile()
    const now = (): number => ms('2026-10-23')
    const y1 = rec({ id: 'Y1', at: at('2026-10-22', 0) })
    const y2 = rec({ id: 'Y2', at: at('2026-10-22', 1) })
    const a = rec({ id: 'A', at: at('2026-10-23', 0) })
    const b = rec({ id: 'B', at: at('2026-10-23', 5) })
    const lateC = rec({ id: 'C', at: new Date(ms('2026-10-23') - 60 * 60 * 1000).toISOString() })
    for (const batch of [[y1, y2], [a], [b], [lateC]]) await appendRecords(p, batch, { now })
    const ids = async (f: Parameters<typeof queryRecords>[1]): Promise<string[]> => (await queryRecords(p, f)).map((r) => r.id)
    expect(await ids({})).toEqual(['B', 'A', 'C', 'Y2', 'Y1'])
    expect(await ids({ limit: 2 })).toEqual(['B', 'A'])
    expect(await ids({ limit: 2, until: a.at })).toEqual(['C', 'Y2'])
    expect(await ids({ limit: 2, until: y2.at })).toEqual(['Y1'])
  })

  it('orders records of the same time by id', async () => {
    const p = await profile()
    const t = at('2026-10-23')
    await appendRecords(p, [rec({ id: 'au_b', at: t }), rec({ id: 'au_c', at: t }), rec({ id: 'au_a', at: t })], { now: () => ms('2026-10-23') })
    expect((await queryRecords(p, {})).map((r) => r.id)).toEqual(['au_c', 'au_b', 'au_a'])
    expect((await queryRecords(p, { limit: 2 })).map((r) => r.id)).toEqual(['au_c', 'au_b'])
  })

  it('pages back with until and beforeId through records that share one time across the page ends, each seen once', async () => {
    const p = await profile()
    const now = (): number => ms('2026-10-23')
    // Seven records at one time between two at other times, written out of order
    const same = ['au_c', 'au_g', 'au_a', 'au_e', 'au_b', 'au_f', 'au_d'].map((id) => rec({ id, at: at('2026-10-23', 30) }))
    const after = rec({ id: 'au_z', at: at('2026-10-23', 31) })
    const before = rec({ id: 'au_y', at: at('2026-10-23', 29) })
    await appendRecords(p, [same[0], same[1], before, same[2], same[3], after, same[4], same[5], same[6]], { now })
    const seen: string[] = []
    let cursor: { until: string; beforeId: string } | undefined
    for (;;) {
      const page = await queryRecords(p, { limit: 3, ...cursor })
      if (page.length === 0) break
      seen.push(...page.map((r) => r.id))
      const last = page[page.length - 1]
      cursor = { until: last.at, beforeId: last.id }
    }
    expect(seen).toEqual(['au_z', 'au_g', 'au_f', 'au_e', 'au_d', 'au_c', 'au_b', 'au_a', 'au_y'])
    // Without beforeId, until alone still leaves out its own time
    expect((await queryRecords(p, { until: same[0].at })).map((r) => r.id)).toEqual(['au_y'])
  })

  it('pages back with until through records written out of order over three days, each seen once and in time order', async () => {
    const p = await profile()
    const now = (): number => ms('2026-10-23')
    // 60 records, one a minute from the 21st to the 23rd, written in a shuffled order
    const all = Array.from({ length: 60 }, (_, i) => rec({ id: `au_${String(i).padStart(2, '0')}`, at: at(['2026-10-21', '2026-10-22', '2026-10-23'][i % 3], i) }))
    const shuffled = [...all].sort((x, y) => ((Number(x.id.slice(3)) * 37) % 61) - ((Number(y.id.slice(3)) * 37) % 61))
    for (let i = 0; i < shuffled.length; i += 7) await appendRecords(p, shuffled.slice(i, i + 7), { now })
    const seen: AuditRecord[] = []
    let until: string | undefined
    for (;;) {
      const page = await queryRecords(p, { limit: 7, ...(until !== undefined ? { until } : {}) })
      if (page.length === 0) break
      seen.push(...page)
      until = page[page.length - 1].at
    }
    const byTime = [...all].sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
    expect(seen.map((r) => r.id)).toEqual(byTime.map((r) => r.id))
  })

  it('filters by session, Job, Run, Task, agent profile, action, period and a predicate, and stops at the limit', async () => {
    const p = await profile()
    const now = (): number => ms('2026-10-23')
    const r1 = rec({ at: at('2026-10-21'), sessionId: 's1', jobId: 'j1', runId: 'r1', taskId: 't1', agentProfileId: 'ap1' })
    const r2 = rec({ at: at('2026-10-22'), sessionId: 's1', jobId: 'j1', runId: 'r2', taskId: 't2', action: 'filesystem.read', target: 'a.ts' })
    const r3 = rec({ at: at('2026-10-23'), sessionId: 's2' })
    await appendRecords(p, [r1, r2, r3], { now })
    const ids = async (f: Parameters<typeof queryRecords>[1]): Promise<string[]> => (await queryRecords(p, f)).map((r) => r.id)
    expect(await ids({ sessionId: 's1' })).toEqual([r2.id, r1.id])
    expect(await ids({ jobId: 'j1' })).toEqual([r2.id, r1.id])
    expect(await ids({ runId: 'r1' })).toEqual([r1.id])
    expect(await ids({ taskId: 't2' })).toEqual([r2.id])
    expect(await ids({ agentProfileId: 'ap1' })).toEqual([r1.id])
    expect(await ids({ action: 'git.remote.write' })).toEqual([r3.id, r1.id])
    // A trailing * matches the start of an action, as in a rule
    expect(await ids({ action: 'git.*' })).toEqual([r3.id, r1.id])
    expect(await ids({ action: 'filesystem.*' })).toEqual([r2.id])
    // since is inclusive, until is not
    expect(await ids({ since: at('2026-10-22') })).toEqual([r3.id, r2.id])
    expect(await ids({ until: at('2026-10-22') })).toEqual([r1.id])
    expect(await ids({ since: at('2026-10-22'), until: at('2026-10-23') })).toEqual([r2.id])
    expect(await ids({ where: (r) => r.target === 'a.ts' })).toEqual([r2.id])
    expect(await ids({ limit: 2 })).toEqual([r3.id, r2.id])
  })

  it('reads nothing and writes nothing when there is no folder', async () => {
    const p = await profile()
    expect(await queryRecords(p, {})).toEqual([])
    await pruneRecords(p)
    expect(await fs.stat(auditDir(p)).then(() => true, () => false)).toBe(false)
  })

  it('skips damaged lines, and a torn last line does not swallow the next record', async () => {
    const p = await profile()
    const now = (): number => ms('2026-10-23')
    await fs.mkdir(auditDir(p), { recursive: true })
    const kept = rec()
    // A crash mid-write left the file ending inside a line
    await fs.writeFile(path.join(auditDir(p), '2026-10-23.jsonl'), `not json\n${JSON.stringify(kept)}\n{"id":"au_torn","at":`)
    const next = rec({ at: at('2026-10-23', 5) })
    await appendRecords(p, [next], { now })
    expect((await queryRecords(p, {})).map((r) => r.id)).toEqual([next.id, kept.id])
  })

  it('looks at the end of the file before every write, so a line torn after its last write does not swallow the next', async () => {
    const p = await profile()
    const now = (): number => ms('2026-10-23')
    const first = rec({ at: at('2026-10-23', 1) })
    await appendRecords(p, [first], { now })
    await fs.appendFile(path.join(auditDir(p), '2026-10-23.jsonl'), '{"id":"au_torn","at":')
    const next = rec({ at: at('2026-10-23', 2) })
    await appendRecords(p, [next], { now })
    expect((await queryRecords(p, {})).map((r) => r.id)).toEqual([next.id, first.id])
  })

  it('never throws to the caller: a write that fails is logged and dropped', async () => {
    const p = await profile()
    // The folder cannot be made: a file stands where it would be
    await fs.writeFile(auditDir(p), 'in the way')
    const logs: string[] = []
    await expect(appendRecords(p, [rec()], { log: (m) => logs.push(m), now: () => ms('2026-10-23') })).resolves.toBeUndefined()
    expect(logs.join('\n')).toMatch(/audit: could not write 1 record/)
  })

  it('drops a record whose time does not parse, says so, and writes the others', async () => {
    const p = await profile()
    const logs: string[] = []
    const good = rec()
    await appendRecords(p, [rec({ at: 'not a time' }), good], { now: () => ms('2026-10-23'), log: (m) => logs.push(m) })
    expect(await files(p)).toEqual(['2026-10-23.jsonl'])
    expect((await queryRecords(p, {})).map((r) => r.id)).toEqual([good.id])
    expect(logs.join('\n')).toMatch(/1 record\(s\) with a time that does not parse/)
  })

  it('writes one append after another, so concurrent calls never interleave lines', async () => {
    const p = await profile()
    const now = (): number => ms('2026-10-23')
    const batches = Array.from({ length: 20 }, (_, i) => Array.from({ length: 5 }, (_, j) => rec({ at: at('2026-10-23', i), id: `au_${i}_${j}` })))
    await Promise.all(batches.map((b) => appendRecords(p, b, { now })))
    expect(await queryRecords(p, {})).toHaveLength(100)
  })
})

describe('retention (Review Focus 4)', () => {
  it('keeps the limits the design names', () => {
    expect(AUDIT_KEEP_DAYS).toBe(30)
    expect(AUDIT_MAX_BYTES).toBe(50 * 1024 * 1024)
  })

  it('drops days older than 30 days, and leaves other files alone', async () => {
    const p = await profile()
    await fs.mkdir(auditDir(p), { recursive: true })
    for (const day of ['2026-09-01', '2026-09-22', '2026-09-23', '2026-10-01']) await fs.writeFile(path.join(auditDir(p), `${day}.jsonl`), `${JSON.stringify(rec({ at: at(day) }))}\n`)
    await fs.writeFile(path.join(auditDir(p), 'notes.txt'), 'mine')
    await appendRecords(p, [rec()], { now: () => ms('2026-10-23') })
    // 2026-09-23 is 30 days before 2026-10-23: kept; the days before it go
    expect(await files(p)).toEqual(['2026-09-23.jsonl', '2026-10-01.jsonl', '2026-10-23.jsonl', 'notes.txt'])
  })

  it('drops the oldest days first once the folder passes its size, and a write still lands', async () => {
    const p = await profile()
    await fs.mkdir(auditDir(p), { recursive: true })
    const day = (d: string): Promise<void> => fs.writeFile(path.join(auditDir(p), `${d}.jsonl`), 'x'.repeat(399) + '\n')
    for (const d of ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']) await day(d)
    const logs: string[] = []
    const newest = rec()
    await appendRecords(p, [newest], { now: () => ms('2026-10-23'), maxBytes: 1000, log: (m) => logs.push(m) })
    expect(await files(p)).toEqual(['2026-10-21.jsonl', '2026-10-22.jsonl', '2026-10-23.jsonl'])
    expect((await queryRecords(p, {})).map((r) => r.id)).toEqual([newest.id])
    expect(logs).toEqual([])
  })

  it('checks at most once an hour, and at the first write of the process', async () => {
    const p = await profile()
    await fs.mkdir(auditDir(p), { recursive: true })
    let now = ms('2026-10-23')
    await appendRecords(p, [rec()], { now: () => now })
    await fs.writeFile(path.join(auditDir(p), '2026-09-01.jsonl'), '\n')
    now += 30 * 60 * 1000
    await appendRecords(p, [rec()], { now: () => now })
    expect(await files(p)).toContain('2026-09-01.jsonl')
    now += 31 * 60 * 1000
    await appendRecords(p, [rec()], { now: () => now })
    expect(await files(p)).not.toContain('2026-09-01.jsonl')
  })

  it('prunes on its own at the Host start, with nothing to write', async () => {
    const p = await profile()
    await fs.mkdir(auditDir(p), { recursive: true })
    await fs.writeFile(path.join(auditDir(p), '2026-09-01.jsonl'), '\n')
    await pruneRecords(p, { now: () => ms('2026-10-23') })
    expect(await files(p)).toEqual([])
  })

  // Credentials final review M9: the credential uses share the retention, and a Host that records none for weeks still
  // lets their old days go
  it('prunes the credential uses beside the tool calls, with nothing to write', async () => {
    const p = await profile()
    const uses = profilePaths(p).credentialUses
    await fs.mkdir(uses, { recursive: true })
    await fs.writeFile(path.join(uses, '2026-09-20.jsonl'), '\n')
    await fs.writeFile(path.join(uses, '2026-10-22.jsonl'), '\n')
    await pruneRecords(p, { now: () => ms('2026-10-23') })
    expect((await fs.readdir(uses)).sort()).toEqual(['2026-10-22.jsonl'])
  })

  // Final review M4: a Host that writes nothing for days (observe off, or no session) still lets the old days go
  it('prunes at the start and then every hour, with nothing to write, until stopped', async () => {
    const p = await profile()
    await fs.mkdir(auditDir(p), { recursive: true })
    await fs.writeFile(path.join(auditDir(p), '2026-09-23.jsonl'), '\n')
    let now = ms('2026-10-23')
    let tick: (() => void) | null = null
    let period = 0
    // An append of nothing takes its turn after every prune queued before it and does none itself: so it only waits
    const settled = (): Promise<void> => appendRecords(p, [])
    const stop = keepPruning(p, {
      now: () => now,
      every: (ms_, fn) => {
        period = ms_
        tick = fn
        return () => (tick = null)
      }
    })
    expect(period).toBe(AUDIT_PRUNE_EVERY_MS)
    await settled() // the start's prune
    expect(await files(p)).toEqual(['2026-09-23.jsonl'])
    // A day on, the only thing that can let 2026-09-23 go is the hour's prune: nothing here prunes but the timer
    now = ms('2026-10-24')
    await settled()
    expect(await files(p)).toEqual(['2026-09-23.jsonl'])
    tick!()
    await settled()
    expect(await files(p)).toEqual([])
    stop()
    expect(tick).toBeNull()
  })

  it('reads no day past the kept days, though its file is still there', async () => {
    const p = await profile()
    await fs.mkdir(auditDir(p), { recursive: true })
    const old = rec({ at: at('2026-09-22') })
    const kept = rec({ at: at('2026-09-23') })
    for (const r of [old, kept]) await fs.writeFile(path.join(auditDir(p), `${auditDayOf(r.at)}.jsonl`), `${JSON.stringify(r)}\n`)
    const o = { now: () => ms('2026-10-23') }
    expect((await queryRecords(p, {}, o)).map((r) => r.id)).toEqual([kept.id])
    expect((await queryRecords(p, { limit: 5 }, o)).map((r) => r.id)).toEqual([kept.id])
    const seen: string[] = []
    await visitRecords(p, {}, (r) => void seen.push(r.id), o)
    expect(seen).toEqual([kept.id])
  })

  it('counts what it wrote since the last check, so the size holds between the hourly checks', async () => {
    const p = await profile()
    await fs.mkdir(auditDir(p), { recursive: true })
    for (const d of ['2026-10-21', '2026-10-22']) await fs.writeFile(path.join(auditDir(p), `${d}.jsonl`), 'x'.repeat(799) + '\n')
    let now = ms('2026-10-23')
    const o = { now: () => now, maxBytes: 2000 }
    await appendRecords(p, [rec()], o)
    expect(await files(p)).toEqual(['2026-10-21.jsonl', '2026-10-22.jsonl', '2026-10-23.jsonl'])
    // Two minutes on, well inside the hour: two more records would pass the size, so the oldest day goes first
    now += 2 * 60 * 1000
    await appendRecords(p, [rec({ at: at('2026-10-23', 1) }), rec({ at: at('2026-10-23', 2) })], o)
    expect(await files(p)).toEqual(['2026-10-22.jsonl', '2026-10-23.jsonl'])
    expect(await queryRecords(p, {})).toHaveLength(3)
  })

  it('stops a day from its own size, not from what a removal that failed left behind', async () => {
    const p = await profile()
    await fs.mkdir(auditDir(p), { recursive: true })
    await fs.writeFile(path.join(auditDir(p), '2026-10-21.jsonl'), 'x'.repeat(1199) + '\n')
    const rm = vi.spyOn(fs, 'rm').mockRejectedValueOnce(Object.assign(new Error('held by another program'), { code: 'EBUSY' }))
    try {
      const logs: string[] = []
      const today = rec()
      await appendRecords(p, [today], { now: () => ms('2026-10-23'), maxBytes: 1000, log: (m) => logs.push(m) })
      expect((await queryRecords(p, {})).map((r) => r.id)).toEqual([today.id])
      expect(auditStoppedAtLimit(p)).toBe(false)
      expect(logs.join('\n')).toMatch(/could not remove/)
    } finally {
      rm.mockRestore()
    }
  })

  it('stops filing a day that alone passes the size, and says so once, rather than growing without end', async () => {
    const p = await profile()
    await fs.mkdir(auditDir(p), { recursive: true })
    await fs.writeFile(path.join(auditDir(p), '2026-10-23.jsonl'), 'x'.repeat(1999) + '\n')
    const logs: string[] = []
    const o = { now: () => ms('2026-10-23'), maxBytes: 1000, log: (m: string) => logs.push(m) }
    await appendRecords(p, [rec()], o)
    await appendRecords(p, [rec()], o)
    expect((await fs.stat(path.join(auditDir(p), '2026-10-23.jsonl'))).size).toBe(2000)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/2026-10-23/)
    // And a count over a period that holds the day says its records stopped there
    expect(auditStoppedAtLimit(p)).toBe(true)
    expect(auditStoppedAtLimit(p, { since: at('2026-10-23'), until: at('2026-10-24') })).toBe(true)
    expect(auditStoppedAtLimit(p, { until: at('2026-10-22') })).toBe(false)
    // The next day is filed again
    await appendRecords(p, [rec({ at: at('2026-10-24') })], { ...o, now: () => ms('2026-10-24') })
    expect(await files(p)).toContain('2026-10-24.jsonl')
  })
})

describe('auditStoppedAtLimit at the edges of a period', () => {
  // `until` is before, as `audit list --until` says (cli usage: "only calls before this time"), and `since` is at or after,
  // so a day is in the period when the period holds an instant of it: not a day that starts at `until`
  it('counts a day when the period holds an instant of it: since is at or after, until is before', async () => {
    const p = await profile()
    await fs.mkdir(auditDir(p), { recursive: true })
    await fs.writeFile(path.join(auditDir(p), '2026-10-24.jsonl'), 'x'.repeat(1999) + '\n')
    await appendRecords(p, [rec({ at: at('2026-10-24') })], { now: () => ms('2026-10-24'), maxBytes: 1000 })
    expect(auditStoppedAtLimit(p)).toBe(true)
    const iso = (ms_: number): string => new Date(ms_).toISOString()
    const startOfDay = new Date(2026, 9, 24).getTime()
    const startOfNext = new Date(2026, 9, 25).getTime()
    // The period ends where the day starts: it holds nothing of it
    expect(auditStoppedAtLimit(p, { until: iso(startOfDay) })).toBe(false)
    expect(auditStoppedAtLimit(p, { since: iso(startOfDay - 60_000), until: iso(startOfDay) })).toBe(false)
    // One millisecond more holds the day's first instant
    expect(auditStoppedAtLimit(p, { until: iso(startOfDay + 1) })).toBe(true)
    // The period starts at the day's last millisecond: it holds it; at the next day's first, it holds nothing of this one
    expect(auditStoppedAtLimit(p, { since: iso(startOfNext - 1) })).toBe(true)
    expect(auditStoppedAtLimit(p, { since: iso(startOfNext) })).toBe(false)
  })
})

describe('a day that stopped at the size, across a restart', () => {
  // Each test starts from the module state a fresh process has, whichever test ran before it
  beforeEach(() => void vi.resetModules())
  /** The store as a Host that just started has it: nothing known of any folder until its start's prune has read it. */
  const restarted = async (): Promise<typeof import('./store')> => {
    vi.resetModules()
    return import('./store')
  }
  /** Fills the day one record at a time until a record no longer fits, as the size cap is small. */
  const fillUntilStopped = async (p: string, o: { now: () => number; maxBytes: number }, day = '2026-10-23'): Promise<void> => {
    for (let i = 0; i < 20 && !auditStoppedAtLimit(p, { since: at(day), until: at(day, 1) }); i++) await appendRecords(p, [rec({ at: at(day, i) })], o)
    expect(auditStoppedAtLimit(p, { since: at(day), until: at(day, 1) })).toBe(true)
  }

  it('says a day stopped at the size after a restart, before this process has written anything, though its file stops short of the size', async () => {
    const p = await profile()
    const o = { now: () => ms('2026-10-23'), maxBytes: 1000 }
    await fillUntilStopped(p, o)
    const size = (await fs.stat(path.join(auditDir(p), '2026-10-23.jsonl'))).size
    // The file never reaches the size: the record that did not fit was refused, so a rule on the file's size alone would miss this day
    expect(size).toBeLessThan(1000)

    const fresh = await restarted()
    expect(fresh.auditStoppedAtLimit(p)).toBe(false) // nothing has looked at the folder yet
    const stop = fresh.keepPruning(p, { ...o, every: () => () => {} })
    await fresh.pruneRecords(p, o) // the Host's start prune, settled
    stop()
    expect(fresh.auditStoppedAtLimit(p)).toBe(true)
    expect(fresh.auditStoppedAtLimit(p, { since: at('2026-10-23'), until: at('2026-10-24') })).toBe(true)
    expect(fresh.auditStoppedAtLimit(p, { until: at('2026-10-22') })).toBe(false)
    // And the day is still not filed further
    await fresh.appendRecords(p, [rec({ at: at('2026-10-23', 30) })], o)
    expect((await fs.stat(path.join(auditDir(p), '2026-10-23.jsonl'))).size).toBe(size)
  })

  it('does not say it of a day that did not stop', async () => {
    const p = await profile()
    const o = { now: () => ms('2026-10-23'), maxBytes: 1500 }
    await appendRecords(p, [rec()], o)
    const fresh = await restarted()
    await fresh.pruneRecords(p, o)
    expect(fresh.auditStoppedAtLimit(p)).toBe(false)
  })

  it('forgets a day with its file: the days past the kept ones, and a mark whose file is not there', async () => {
    const p = await profile()
    const o = { now: () => ms('2026-10-23'), maxBytes: 1000 }
    await fillUntilStopped(p, o)
    expect(await files(p)).toEqual(['2026-10-23.jsonl', '2026-10-23.stopped'])
    // Thirty-one days on, the day is past the kept days: its file goes, and its mark with it
    const later = { now: () => ms('2026-11-23'), maxBytes: 1000 }
    const fresh = await restarted()
    await fresh.pruneRecords(p, later)
    expect(await files(p)).toEqual([])
    expect(fresh.auditStoppedAtLimit(p)).toBe(false)
    // A mark left alone by a file that was removed by hand says nothing, and is cleaned up
    await fs.mkdir(auditDir(p), { recursive: true })
    await fs.writeFile(path.join(auditDir(p), '2026-11-22.stopped'), '')
    await fresh.pruneRecords(p, later)
    expect(await files(p)).toEqual([])
    expect(fresh.auditStoppedAtLimit(p)).toBe(false)
  })
})

describe('reading a large day', () => {
  /** A day of `count` records, a second apart in the order they were written, about 10 MB at 30 000. */
  async function largeDay(count: number, day = '2026-10-23', into?: string): Promise<{ p: string; newest: string[] }> {
    const p = into ?? (await profile())
    await fs.mkdir(auditDir(p), { recursive: true })
    const start = ms(day) - 6 * 60 * 60 * 1000
    const lines: string[] = []
    for (let i = 0; i < count; i++) lines.push(JSON.stringify(rec({ id: `au_big_${i}`, at: new Date(start + i * 1000).toISOString(), target: `src/some/folder/file${i}.ts` })))
    await fs.writeFile(path.join(auditDir(p), `${day}.jsonl`), lines.join('\n') + '\n')
    return { p, newest: [count - 1, count - 2, count - 3].map((i) => `au_big_${i}`) }
  }

  it('reads the newest day whole for a page and does not open an older day once the page is full', async () => {
    const { p, newest } = await largeDay(30_000, '2026-10-22')
    // Ten records today, written out of their time order
    const today = [5, 1, 9, 3, 7, 0, 8, 2, 6, 4].map((m) => rec({ id: `au_today_${m}`, at: at('2026-10-23', m) }))
    await appendRecords(p, today, { now: () => ms('2026-10-23') })
    let looked = 0
    const page = await queryRecords(p, { limit: 3, where: () => (looked++, true) })
    expect(page.map((r) => r.id)).toEqual(['au_today_9', 'au_today_8', 'au_today_7'])
    expect(looked).toBe(10)
    // A page longer than today goes on into yesterday, newest first there too
    const longer = await queryRecords(p, { limit: 12 })
    expect(longer.map((r) => r.id)).toEqual([...[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((m) => `au_today_${m}`), ...newest.slice(0, 2)])
  })

  it('gives the event loop a turn every few thousand lines while it reads the whole day', async () => {
    const { p } = await largeDay(30_000)
    let seen = 0
    let done = false
    let mostBetweenTurns = 0
    let atLastTurn = 0
    const sample = (): void => {
      mostBetweenTurns = Math.max(mostBetweenTurns, seen - atLastTurn)
      atLastTurn = seen
      if (!done) setImmediate(sample)
    }
    setImmediate(sample)
    const all = await queryRecords(p, { where: () => (seen++, true) })
    done = true
    sample()
    expect(all).toHaveLength(30_000)
    expect(mostBetweenTurns).toBeLessThanOrEqual(2 * AUDIT_READ_YIELD_EVERY)
  })
})
