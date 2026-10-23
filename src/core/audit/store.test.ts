// Observe mode's record store (design §8): the Host's append-only JSONL under `<profile>/audit/`, one file per local day,
// kept 30 days or 50 MB, whichever comes first. A write never fails the source (Review Focus 4).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { profilePaths } from '../profile/paths'
import {
  AUDIT_KEEP_DAYS,
  AUDIT_MAX_BYTES,
  AUDIT_READ_YIELD_EVERY,
  appendRecords,
  auditDayOf,
  auditStoppedAtLimit,
  pruneRecords,
  queryRecords,
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

describe('reading a large day', () => {
  /** A day of `count` records, a second apart in the order they were written, about 10 MB at 30 000. */
  async function largeDay(count: number): Promise<{ p: string; newest: string[] }> {
    const p = await profile()
    await fs.mkdir(auditDir(p), { recursive: true })
    const start = ms('2026-10-23') - 6 * 60 * 60 * 1000
    const lines: string[] = []
    for (let i = 0; i < count; i++) lines.push(JSON.stringify(rec({ id: `au_big_${i}`, at: new Date(start + i * 1000).toISOString(), target: `src/some/folder/file${i}.ts` })))
    await fs.writeFile(path.join(auditDir(p), '2026-10-23.jsonl'), lines.join('\n') + '\n')
    return { p, newest: [count - 1, count - 2, count - 3].map((i) => `au_big_${i}`) }
  }

  it('reads a page of the newest from the end of the file and stops there', async () => {
    const { p, newest } = await largeDay(30_000)
    let looked = 0
    const page = await queryRecords(p, { limit: 3, where: () => (looked++, true) })
    expect(page.map((r) => r.id)).toEqual(newest)
    expect(looked).toBe(3)
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
