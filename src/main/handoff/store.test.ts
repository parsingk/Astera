import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HandoffStore, HANDOFF_KEEP_MAX } from './store'
import type { Handoff } from '../../core/handoff/types'

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-handoff-'))
  file = path.join(dir, 'handoff.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const memo = (sessionId: string, createdAt = '2026-09-08T09:00:00.000Z'): Handoff => ({
  version: 1,
  sessionId,
  projectPath: 'C:/p',
  provider: 'claude',
  createdAt,
  git: { branch: 'main', head: 'abc' },
  completed: ['a'],
  currentProblems: [],
  nextActions: [],
  constraints: ['no Redis'],
  decisions: [],
  verification: [],
  relevantFiles: []
})

describe('HandoffStore', () => {
  it('before load, every lookup is unknown', () => {
    const s = new HandoffStore(file)
    expect(s.lookup('s-1')).toEqual({ state: 'unknown' })
  })

  it('a missing file loads as empty: lookups answer none', async () => {
    const s = new HandoffStore(file)
    expect((await s.load()).recovered).toBe(false)
    expect(s.lookup('s-1')).toEqual({ state: 'none' })
  })

  it('save then lookup, and the file reloads the same', async () => {
    const a = new HandoffStore(file)
    await a.load()
    await a.save(memo('s-1'))
    expect(a.lookup('s-1')).toEqual({ state: 'found', memo: memo('s-1') })
    const b = new HandoffStore(file)
    await b.load()
    expect(b.lookup('s-1')).toEqual({ state: 'found', memo: memo('s-1') })
    expect(b.lookup('s-2')).toEqual({ state: 'none' })
  })

  it('one memo per session — the newer replaces the older', async () => {
    const s = new HandoffStore(file)
    await s.load()
    await s.save(memo('s-1', '2026-09-08T09:00:00.000Z'))
    await s.save({ ...memo('s-1', '2026-09-08T10:00:00.000Z'), constraints: ['keep the API'] })
    const r = s.lookup('s-1')
    expect(r.state).toBe('found')
    if (r.state === 'found') expect(r.memo.constraints).toEqual(['keep the API'])
  })

  it(`keeps the ${HANDOFF_KEEP_MAX} most recent sessions and drops the oldest`, async () => {
    const s = new HandoffStore(file)
    await s.load()
    for (let i = 0; i <= HANDOFF_KEEP_MAX; i++) {
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
      await s.save(memo(`s-${i}`, t))
    }
    expect(s.lookup('s-0')).toEqual({ state: 'none' }) // the oldest went
    expect(s.lookup(`s-${HANDOFF_KEEP_MAX}`).state).toBe('found')
    expect(s.lookup('s-1').state).toBe('found')
  })

  it('a corrupt file goes to .bak and lookups answer unknown, not none', async () => {
    await fs.writeFile(file, '{ not json', 'utf8')
    const s = new HandoffStore(file)
    expect((await s.load()).recovered).toBe(true)
    await expect(fs.readFile(file + '.bak', 'utf8')).resolves.toBe('{ not json')
    expect(s.lookup('s-1')).toEqual({ state: 'unknown' })
  })

  it('a file with the wrong shape is treated the same', async () => {
    await fs.writeFile(file, JSON.stringify({ version: 1, memos: { 's-1': { nope: true } } }), 'utf8')
    const s = new HandoffStore(file)
    expect((await s.load()).recovered).toBe(true)
    expect(s.lookup('s-1')).toEqual({ state: 'unknown' })
  })

  it('a memo missing one of the list fields fails the guard', async () => {
    const { completed: _completed, ...withoutCompleted } = memo('s-1')
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, memos: { 's-1': withoutCompleted } }),
      'utf8'
    )
    const s = new HandoffStore(file)
    expect((await s.load()).recovered).toBe(true)
    expect(s.lookup('s-1')).toEqual({ state: 'unknown' })
  })

  it('a save after a failed load starts from empty and lookups answer again', async () => {
    await fs.writeFile(file, '{ not json', 'utf8')
    const s = new HandoffStore(file)
    await s.load()
    await s.save(memo('s-9'))
    expect(s.lookup('s-9').state).toBe('found')
    expect(s.lookup('s-1')).toEqual({ state: 'none' })
  })

  it('a write that fails leaves the previous file intact and the memo out of memory', async () => {
    const good = new HandoffStore(file)
    await good.load()
    await good.save(memo('s-1'))
    const failing = new HandoffStore(file, {
      writeFile: async () => {
        throw new Error('disk full')
      }
    })
    await failing.load()
    await expect(failing.save(memo('s-2'))).rejects.toThrow('disk full')
    expect(failing.lookup('s-2')).toEqual({ state: 'none' })
    const reread = new HandoffStore(file)
    await reread.load()
    expect(reread.lookup('s-1').state).toBe('found')
    expect(reread.lookup('s-2')).toEqual({ state: 'none' })
  })

  it('a failed write does not stall the next save', async () => {
    let fail = true
    const s = new HandoffStore(file, {
      writeFile: async (p, c) => {
        if (fail) throw new Error('once')
        await fs.writeFile(p, c, 'utf8')
      }
    })
    await s.load()
    await expect(s.save(memo('s-1'))).rejects.toThrow('once')
    fail = false
    await s.save(memo('s-2'))
    expect(s.lookup('s-2').state).toBe('found')
  })

  it('two saves in flight both land — the next state is computed inside the queued run', async () => {
    const s = new HandoffStore(file)
    await s.load()
    const first = s.save(memo('s-1'))
    const second = s.save(memo('s-2'))
    await Promise.all([first, second])
    expect(s.lookup('s-1').state).toBe('found')
    expect(s.lookup('s-2').state).toBe('found')
    const reread = new HandoffStore(file)
    await reread.load()
    expect(reread.lookup('s-1').state).toBe('found')
    expect(reread.lookup('s-2').state).toBe('found')
  })
})
