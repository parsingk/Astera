import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import type { OrchState } from '../core/orchestration/state'
import type { Diagnostic, DiagnosticProducer } from '../core/problems/diagnostic'
import { completionProducer, createProblems } from './problems'

const PROJECT = path.resolve('/repo')
const WT = path.resolve('/wt/t1')
const at = (...p: string[]): string => path.join(...p)

function state(file: string): OrchState {
  return {
    jobs: [{ id: 'j1', objective: 'o', cwd: PROJECT }],
    runs: [{ id: 'r1', jobId: 'j1', ordinal: 1, createdAt: '2026-11-25T00:00:00Z' }],
    tasks: [
      {
        id: 't1',
        runId: 'r1',
        title: 'task',
        checks: [
          {
            configId: 'plugin:lint',
            name: 'Lint',
            status: 'failed',
            endedAt: '2026-11-25T10:00:00Z',
            diagnostics: [{ file, line: 3, message: 'm' }, { message: 'no file' }]
          }
        ]
      }
    ],
    dispatches: [{ id: 'd1', taskId: 't1', cwd: WT, startedAt: '2026-11-25T09:00:00Z' }],
    messages: [],
    deliveries: [],
    gates: [],
    projects: []
  } as unknown as OrchState
}

const T_CHECK = Date.parse('2026-11-25T10:00:00Z')

describe('completionProducer', () => {
  const produce = (file: string, files: Record<string, number>) =>
    completionProducer({
      state: () => state(file),
      runIdsOf: () => new Set(['j1', 'r1']),
      stat: async (abs) => (abs in files ? { mtimeMs: files[abs] } : null)
    }).diagnostics(PROJECT)

  it('finds a file in the Task\'s worker folder first, and leaves a finding unmarked when the file is as it was', async () => {
    const [d, noFile] = await produce('src/a.ts', { [at(WT, 'src', 'a.ts')]: T_CHECK - 1000, [at(PROJECT, 'src', 'a.ts')]: T_CHECK - 1000 })
    expect(d.path).toBe(at(WT, 'src', 'a.ts'))
    expect(d.stale).toBeUndefined()
    expect(d).not.toHaveProperty('file')
    expect(d).not.toHaveProperty('folders')
    expect(noFile.path).toBeUndefined()
    expect(noFile.stale).toBeUndefined()
  })

  // Review focus 1: the Task's worktree was removed after its work merged.
  it('falls back to the project when the worker folder no longer holds the file', async () => {
    const [d] = await produce('src/a.ts', { [at(PROJECT, 'src', 'a.ts')]: T_CHECK - 1000 })
    expect(d.path).toBe(at(PROJECT, 'src', 'a.ts'))
    expect(d.stale).toBeUndefined()
  })

  // Review focus 2.
  it('marks a finding stale when its file changed after it, and missing when the file is nowhere', async () => {
    const [changed] = await produce('src/a.ts', { [at(WT, 'src', 'a.ts')]: T_CHECK + 1000 })
    expect(changed.stale).toBe('changed')
    const [gone] = await produce('src/a.ts', {})
    expect(gone.stale).toBe('missing')
    expect(gone.path).toBe(at(PROJECT, 'src', 'a.ts'))
  })

  it('keeps an absolute file as it is', async () => {
    const abs = at(path.resolve('/elsewhere'), 'x.ts')
    const [d] = await produce(abs, { [abs]: T_CHECK - 1 })
    expect(d.path).toBe(abs)
  })

  it('answers nothing without orchestration', async () => {
    const p = completionProducer({ state: () => null, runIdsOf: () => new Set(), stat: async () => null })
    expect(await p.diagnostics(PROJECT)).toEqual([])
  })
})

const diag = (id: string): Diagnostic => ({ schemaVersion: 1, id, source: { kind: 'check', id: 'x', label: 'X' }, severity: 'error', message: id })

describe('createProblems', () => {
  it('refuses a project the path guard refuses, asking no producer', async () => {
    const producer: DiagnosticProducer = { id: 'p', diagnostics: vi.fn(async () => [diag('a')]) }
    const list = createProblems({
      producers: [producer],
      allowedRoot: async () => {
        throw new Error('not allowed')
      }
    })
    await expect(list(PROJECT)).rejects.toThrow('not allowed')
    expect(producer.diagnostics).not.toHaveBeenCalled()
    await expect(list(42)).rejects.toThrow()
  })

  it('merges every producer, and one that fails does not take the others with it', async () => {
    const list = createProblems({
      producers: [
        { id: 'a', diagnostics: async () => [diag('a1'), diag('a2')] },
        { id: 'b', diagnostics: async () => Promise.reject(new Error('down')) },
        { id: 'c', diagnostics: async () => [diag('c1')] }
      ],
      allowedRoot: async (p) => p
    })
    expect((await list(PROJECT)).map((d) => d.id)).toEqual(['a1', 'a2', 'c1'])
  })
})
