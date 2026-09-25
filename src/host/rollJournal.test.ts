import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tempDir } from '../core/worktrees/testRepo'
import { createRollJournal, journalEntryOf, boundEntries, rollJournalPath, JOURNAL_MAX_AGE_MS, JOURNAL_PER_CHAIN } from './rollJournal'
import type { HostRollEvent } from './rolling'
import type { RollJournalEntry } from '../core/host/protocol'
import type { SessionInfo } from '../core/types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

const T0 = Date.parse('2026-09-25T00:00:00.000Z')
async function journalIn(o: { now?: () => number } = {}) {
  const dir = await tempDir('astera-roll-journal-')
  dirs.push(dir)
  const logs: string[] = []
  let clock = T0
  const now = o.now ?? (() => clock)
  const make = () => createRollJournal({ filePath: rollJournalPath(dir), log: (m) => logs.push(m), nowIso: () => new Date(now()).toISOString() })
  return { dir, logs, file: rollJournalPath(dir), make, tick: (ms: number) => { clock += ms } }
}

const state = (sessionId: string, over: Partial<Extract<HostRollEvent, { t: 'roll-state' }>['event']> = {}): HostRollEvent => ({
  t: 'roll-state',
  event: { sessionId, state: 'waiting', nextRetryAt: '2026-09-25T05:00:00.000Z', scope: 'session', ...over }
})
const rolled = (oldSessionId: string, id: string): HostRollEvent => ({
  t: 'session-rolled',
  oldSessionId,
  info: { id, accountId: 'a2', cwd: '/x', status: 'running', title: 't' } as SessionInfo
})

describe('journalEntryOf (D5: only what a summary needs)', () => {
  it('keeps waiting, switching, nudged, stalled and every roll', () => {
    expect(journalEntryOf(state('s1'))).toEqual({ kind: 'state', sessionId: 's1', state: 'waiting', nextRetryAt: '2026-09-25T05:00:00.000Z', scope: 'session' })
    expect(journalEntryOf(state('s1', { state: 'switching', accountLabel: 'work', nextRetryAt: undefined, scope: undefined }))).toEqual({ kind: 'state', sessionId: 's1', state: 'switching', accountLabel: 'work' })
    expect(journalEntryOf(state('s1', { state: 'nudged', nextRetryAt: undefined, scope: undefined }))).toEqual({ kind: 'state', sessionId: 's1', state: 'nudged' })
    expect(journalEntryOf(state('s1', { state: 'stalled', nextRetryAt: undefined, scope: undefined }))).toEqual({ kind: 'state', sessionId: 's1', state: 'stalled' })
    expect(journalEntryOf(rolled('s1', 's2'))).toEqual({ kind: 'rolled', sessionId: 's2', oldSessionId: 's1' })
  })
  it('leaves out trust, none, adopted and a reattach (a restored wait is not new)', () => {
    for (const s of ['trust', 'none', 'adopted'] as const) expect(journalEntryOf(state('s1', { state: s }))).toBeNull()
    expect(journalEntryOf(state('s1', { reattach: true }))).toBeNull()
    expect(journalEntryOf(state('s1', { state: 'switching', reattach: true }))).toBeNull()
  })
})

describe('boundEntries (D5 bounds)', () => {
  const e = (seq: number, sessionId: string, at = T0, over: Partial<RollJournalEntry> = {}): RollJournalEntry => ({ seq, at: new Date(at).toISOString(), kind: 'state', sessionId, state: 'nudged', ...over })
  it('drops entries older than 7 days', () => {
    const old = e(1, 's1', T0 - JOURNAL_MAX_AGE_MS - 1)
    const fresh = e(2, 's1', T0 - JOURNAL_MAX_AGE_MS + 1)
    expect(boundEntries([old, fresh], T0)).toEqual([fresh])
  })
  it('keeps the newest 64 of a chain, linked through its rolls, and leaves other chains alone', () => {
    const chain: RollJournalEntry[] = []
    let seq = 0
    for (let i = 0; i < 40; i++) chain.push(e(++seq, 's1'))
    chain.push(e(++seq, 's2', T0, { kind: 'rolled', oldSessionId: 's1', state: undefined }))
    for (let i = 0; i < 40; i++) chain.push(e(++seq, 's2'))
    const other = e(++seq, 'z1')
    const out = boundEntries([...chain, other], T0)
    expect(out).toHaveLength(JOURNAL_PER_CHAIN + 1)
    expect(out.map((x) => x.seq)).toEqual([...chain.slice(-JOURNAL_PER_CHAIN).map((x) => x.seq), other.seq])
  })
  it('caps the whole journal', () => {
    const many = Array.from({ length: 1100 }, (_, i) => e(i + 1, `s${i}`))
    const out = boundEntries(many, T0)
    expect(out).toHaveLength(1024)
    expect(out[0].seq).toBe(77)
  })
})

describe('createRollJournal (D5)', () => {
  it('appends an entry with a seq and the time, and writes the file', async () => {
    const j = await journalIn()
    const journal = j.make()
    journal.append(state('s1'))
    journal.append(state('s1', { state: 'trust' }))
    journal.append(rolled('s1', 's2'))
    const got = await journal.take()
    expect(got.lastSeq).toBe(2)
    expect(got.entries).toEqual([
      { seq: 1, at: '2026-09-25T00:00:00.000Z', kind: 'state', sessionId: 's1', state: 'waiting', nextRetryAt: '2026-09-25T05:00:00.000Z', scope: 'session' },
      { seq: 2, at: '2026-09-25T00:00:00.000Z', kind: 'rolled', sessionId: 's2', oldSessionId: 's1' }
    ])
    const onDisk = JSON.parse(await fs.readFile(j.file, 'utf8'))
    expect(onDisk).toMatchObject({ lastSeq: 2, entries: got.entries })
  })
  it('keeps seq rising across a reload, even after every entry was acked', async () => {
    const j = await journalIn()
    const first = j.make()
    first.append(state('s1'))
    first.append(state('s1', { state: 'stalled' }))
    expect((await first.take(2)).entries).toEqual([])
    const second = j.make()
    second.append(state('s3'))
    const got = await second.take()
    expect(got.lastSeq).toBe(3)
    expect(got.entries.map((x) => x.seq)).toEqual([3])
  })
  it('an ack prunes up to it, then answers what is after it', async () => {
    const j = await journalIn()
    const journal = j.make()
    for (let i = 0; i < 4; i++) journal.append(state(`s${i}`))
    expect((await journal.take(2)).entries.map((x) => x.seq)).toEqual([3, 4])
    expect((await journal.take()).entries.map((x) => x.seq)).toEqual([3, 4])
    const reloaded = j.make()
    expect((await reloaded.take()).entries.map((x) => x.seq)).toEqual([3, 4])
  })
  it('applies the age bound on load', async () => {
    const j = await journalIn()
    const journal = j.make()
    journal.append(state('s1'))
    await journal.take()
    j.tick(JOURNAL_MAX_AGE_MS + 1)
    const got = await j.make().take()
    expect(got).toEqual({ entries: [], lastSeq: 1 })
  })
  it('a damaged file loads as empty, is logged, and the journal goes on', async () => {
    const j = await journalIn()
    await fs.mkdir(path.dirname(j.file), { recursive: true })
    await fs.writeFile(j.file, '{ not json', 'utf8')
    const journal = j.make()
    expect(await journal.take()).toEqual({ entries: [], lastSeq: 0 })
    expect(j.logs.some((m) => m.includes('roll journal'))).toBe(true)
    journal.append(state('s1'))
    expect((await journal.take()).entries.map((x) => x.seq)).toEqual([1])
  })
  it('a wrong shape loads as empty, and a bad entry alone is dropped', async () => {
    const j = await journalIn()
    await fs.mkdir(path.dirname(j.file), { recursive: true })
    await fs.writeFile(j.file, JSON.stringify([1, 2]), 'utf8')
    expect(await j.make().take()).toEqual({ entries: [], lastSeq: 0 })
    const good = { seq: 4, at: '2026-09-25T00:00:00.000Z', kind: 'state', sessionId: 's1', state: 'nudged' }
    await fs.writeFile(j.file, JSON.stringify({ v: 1, lastSeq: 9, entries: [good, { seq: 'x' }, { ...good, seq: 5, kind: 'nope' }] }), 'utf8')
    expect(await j.make().take()).toEqual({ entries: [good], lastSeq: 9 })
  })
  it('a write that fails never throws out: it is logged and the entries stay in memory', async () => {
    const j = await journalIn()
    // A directory where the file's parent should be: mkdir and the write both fail.
    await fs.writeFile(path.join(j.dir, 'host'), 'a file, not a folder', 'utf8')
    const journal = j.make()
    expect(() => journal.append(state('s1'))).not.toThrow()
    const got = await journal.take()
    expect(got.entries.map((x) => x.seq)).toEqual([1])
    expect(j.logs.some((m) => m.includes('roll journal could not be written'))).toBe(true)
  })
})
