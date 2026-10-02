import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkRecord } from './types'
import { UnderstandingStore } from '../../main/understanding/store'
import { readUnderstandingFile, recordDetail, recordSummary, recordsFor, type StoreShape } from './read'

let dir: string
let file: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hiw-read-'))
  file = path.join(dir, 'understanding.json')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const record = (over: Partial<WorkRecord> = {}): WorkRecord => ({
  id: 'r1',
  at: '2026-10-01T10:00:00.000Z',
  source: { kind: 'session', sessionId: 's1', label: 'Terminal 1' },
  request: 'add a button',
  changedFiles: ['src/a.ts', 'src/b.ts'],
  git: { startHead: 'aaa', endHead: 'bbb' },
  status: 'ready',
  ...over
})

describe('readUnderstandingFile', () => {
  it('reads a missing file as no projects', async () => {
    expect(await readUnderstandingFile(file)).toEqual({ projects: {} })
  })

  it('reads a valid file as it is', async () => {
    const state: StoreShape = { projects: { 'D:/repo': { records: [record()] } } }
    await fs.writeFile(file, JSON.stringify(state), 'utf8')
    expect(await readUnderstandingFile(file)).toEqual(state)
  })

  it('throws on an invalid shape, without the file text in the message', async () => {
    await fs.writeFile(file, JSON.stringify({ projects: { 'D:/repo': { records: 'sk-secret-in-file' } } }), 'utf8')
    const err = await readUnderstandingFile(file).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/could not be read/)
    expect((err as Error).message).not.toContain('sk-secret-in-file')
  })

  it('throws on text that is not JSON, without the file text in the message', async () => {
    await fs.writeFile(file, '{ not json sk-secret-in-file', 'utf8')
    const err = await readUnderstandingFile(file).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/could not be read/)
    expect((err as Error).message).not.toContain('sk-secret-in-file')
  })

  it('throws on a file it cannot read (a folder in its place)', async () => {
    await fs.mkdir(file)
    await expect(readUnderstandingFile(file)).rejects.toThrow(/could not be read/)
  })

  it('never writes: a file it cannot read is left as it is, with no .bak', async () => {
    await fs.writeFile(file, 'garbage', 'utf8')
    await readUnderstandingFile(file).catch(() => {})
    expect(await fs.readFile(file, 'utf8')).toBe('garbage')
    expect(await fs.readdir(dir)).toEqual(['understanding.json'])
  })

  it('takes and refuses the same shapes the app store does (one guard)', async () => {
    const shapes: Array<[unknown, boolean]> = [
      [{ projects: {} }, true],
      [{ projects: { a: { records: [] } } }, true],
      [{ projects: { a: { records: {} } } }, false],
      [{ projects: { a: null } }, false],
      [{ projects: [] }, false],
      [[], false],
      [{}, false]
    ]
    for (const [shape, valid] of shapes) {
      await fs.writeFile(file, JSON.stringify(shape), 'utf8')
      const store = new UnderstandingStore(file)
      expect((await store.load()).recovered, JSON.stringify(shape)).toBe(!valid)
      await fs.writeFile(file, JSON.stringify(shape), 'utf8')
      const read = await readUnderstandingFile(file).then(
        () => true,
        () => false
      )
      expect(read, JSON.stringify(shape)).toBe(valid)
      await fs.rm(file + '.bak', { force: true })
    }
  })
})

describe('recordsFor', () => {
  const state = (key: string, records: WorkRecord[]): StoreShape => ({ projects: { [key]: { records } } })

  it('gives the records newest first', () => {
    const s = state('D:/repo', [
      record({ id: 'old', at: '2026-09-01T00:00:00.000Z' }),
      record({ id: 'new', at: '2026-10-01T00:00:00.000Z' }),
      record({ id: 'mid', at: '2026-09-15T00:00:00.000Z' })
    ])
    expect(recordsFor(s, 'D:/repo').map((r) => r.id)).toEqual(['new', 'mid', 'old'])
  })

  it('does not reorder the stored list', () => {
    const records = [record({ id: 'old', at: '2026-09-01T00:00:00.000Z' }), record({ id: 'new', at: '2026-10-01T00:00:00.000Z' })]
    recordsFor(state('D:/repo', records), 'D:/repo')
    expect(records.map((r) => r.id)).toEqual(['old', 'new'])
  })

  it('skips a record that is not an object with a string id and at, and reads a missing changedFiles as none', () => {
    const records = [
      null,
      'text',
      { id: 'no-at', status: 'ready' },
      { id: 'bad-at', at: 5 },
      { id: 7, at: '2026-10-01T00:00:00.000Z' },
      { ...record({ id: 'no-files', at: '2026-09-01T00:00:00.000Z' }), changedFiles: undefined },
      record({ id: 'ok', at: '2026-10-01T00:00:00.000Z' })
    ] as unknown as WorkRecord[]
    const got = recordsFor(state('D:/repo', records), 'D:/repo')
    expect(got.map((r) => r.id)).toEqual(['ok', 'no-files'])
    expect(got[1].changedFiles).toEqual([])
    expect(got.map(recordSummary).map((r) => r.changedFiles)).toEqual([2, 0])
  })

  it('gives none for a project with no entry', () => {
    expect(recordsFor(state('D:/repo', [record()]), 'D:/other')).toEqual([])
    expect(recordsFor({ projects: {} }, 'D:/repo')).toEqual([])
  })

  it('matches the key case-insensitively on win32', () => {
    expect(recordsFor(state('D:/Repo', [record()]), 'd:/repo', 'win32')).toHaveLength(1)
  })

  it('matches the key exactly on linux', () => {
    expect(recordsFor(state('/home/u/Repo', [record()]), '/home/u/repo', 'linux')).toEqual([])
  })

  it.runIf(process.platform === 'win32')('matches the key across separators on win32', () => {
    expect(recordsFor(state('D:\\parsingk\\Repo', [record()]), 'd:/parsingk/repo/', 'win32')).toHaveLength(1)
  })
})

describe('recordSummary', () => {
  it('gives the row: title, request, status, source, a count of changed files and the verification status', () => {
    const r = record({
      verification: { status: 'partial', checks: [{ name: 'npm test', status: 'passed' }], summary: 'ran tests' },
      explanation: {
        title: 'Add a button',
        overview: 'o',
        userVisibleChanges: [],
        flow: [],
        decisions: [],
        implementation: [],
        evidence: [],
        userEdited: false,
        generatedAt: 'x'
      }
    })
    expect(recordSummary(r)).toEqual({
      id: 'r1',
      at: '2026-10-01T10:00:00.000Z',
      title: 'Add a button',
      request: 'add a button',
      status: 'ready',
      source: { kind: 'session', sessionId: 's1', label: 'Terminal 1' },
      changedFiles: 2,
      verification: { status: 'partial' }
    })
  })

  it('carries the reason when there is one, and a null title and verification when there are none', () => {
    const s = recordSummary(record({ status: 'failed', reason: 'INTERRUPTED' }))
    expect(s.title).toBeNull()
    expect(s.verification).toBeNull()
    expect(s.reason).toBe('INTERRUPTED')
    expect('reason' in recordSummary(record())).toBe(false)
  })

  it('falls back to the old validation field', () => {
    expect(recordSummary(record({ validation: { status: 'passed', summary: 's' } })).verification).toEqual({ status: 'passed' })
  })

  it('prefers verification over validation', () => {
    const r = record({ validation: { status: 'failed' }, verification: { status: 'verified' } })
    expect(recordSummary(r).verification).toEqual({ status: 'verified' })
  })
})

describe('recordDetail', () => {
  it('gives the whole record', () => {
    const r = record({
      git: { startHead: 'a', endHead: 'b', commits: ['b'] },
      verification: { status: 'verified', checks: [{ name: 't', status: 'passed' }] },
      jobTasks: [{ title: 't', outcome: 'done' }],
      reason: 'why'
    })
    expect(recordDetail(r)).toEqual(r)
  })

  it('carries the old validation when there is no verification', () => {
    const r = record({ validation: { status: 'unknown', summary: 's' } })
    expect(recordDetail(r).validation).toEqual({ status: 'unknown', summary: 's' })
  })
})
