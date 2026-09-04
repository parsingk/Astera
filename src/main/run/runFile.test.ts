import { describe, it, expect, beforeEach } from 'vitest'
import type { RunConfig } from '../../core/run/config'
import { planFileRun } from './runFile'

const py = (id: string, file: string, extra: Partial<RunConfig> = {}): RunConfig =>
  ({ id, name: id, type: 'python', file, ...extra }) as RunConfig
const tmp = (id: string, file: string): RunConfig => py(id, file, { temporary: true })

let n = 0
const newId = (): string => `new:${++n}`
beforeEach(() => {
  n = 0
})

describe('planFileRun', () => {
  it('is null for a file no kind can be inferred from', () => {
    expect(planFileRun({ merged: [], stored: [], relPath: 'Dockerfile', newId })).toBeNull()
  })

  it('creates a temporary configuration when nothing matches', () => {
    const r = planFileRun({ merged: [], stored: [], relPath: 'seed.py', newId })
    expect(r?.configId).toBe('new:1')
    expect(r?.configs).toHaveLength(1)
    expect(r?.configs?.[0]).toMatchObject({ type: 'python', file: 'seed.py', name: 'seed.py', temporary: true })
  })

  // Identity, not the temporary flag, is what "already here" means — so a permanent configuration for
  // the same file is reused and no second row appears.
  it('reuses a permanent configuration with the same identity, storing nothing', () => {
    const existing = py('p1', 'seed.py')
    const r = planFileRun({ merged: [existing], stored: [existing], relPath: 'seed.py', newId })
    expect(r).toEqual({ configId: 'p1', configs: null })
  })

  it('reuses a temporary configuration with the same identity', () => {
    const existing = tmp('t1', 'seed.py')
    const r = planFileRun({ merged: [existing], stored: [existing], relPath: 'seed.py', newId })
    expect(r).toEqual({ configId: 't1', configs: null })
  })

  // A detected configuration lives only in `merged`; reusing it is right and must not copy it into
  // the store.
  it('reuses a detected configuration and stores nothing', () => {
    const seed = py('seed:python:seed.py', 'seed.py')
    const r = planFileRun({ merged: [seed], stored: [], relPath: 'seed.py', newId })
    expect(r).toEqual({ configId: 'seed:python:seed.py', configs: null })
  })

  it('evicts the earliest temporary configuration past the cap', () => {
    const stored = [tmp('t1', 'a.py'), tmp('t2', 'b.py'), tmp('t3', 'c.py'), tmp('t4', 'd.py'), tmp('t5', 'e.py')]
    const r = planFileRun({ merged: stored, stored, relPath: 'f.py', newId })
    expect(r?.configs?.map((c) => c.id)).toEqual(['t2', 't3', 't4', 't5', 'new:1'])
  })

  // Only temporary ones are evicted, however early a permanent one sits in the list.
  it('never evicts a permanent configuration', () => {
    const stored = [
      py('p1', 'keep.py'),
      tmp('t1', 'a.py'), tmp('t2', 'b.py'), tmp('t3', 'c.py'), tmp('t4', 'd.py'), tmp('t5', 'e.py')
    ]
    const r = planFileRun({ merged: stored, stored, relPath: 'f.py', newId })
    expect(r?.configs?.map((c) => c.id)).toEqual(['p1', 't2', 't3', 't4', 't5', 'new:1'])
  })

  // "seed.py copy" would say nothing about which file it runs.
  it('falls back to the relative path when the basename is taken', () => {
    const existing = py('p1', 'other/seed.py', { name: 'seed.py' })
    const r = planFileRun({ merged: [existing], stored: [existing], relPath: 'scripts/seed.py', newId })
    expect(r?.configs?.[1]).toMatchObject({ name: 'scripts/seed.py' })
  })

  // The case every other one above leaves untested: merged holding something stored does not, while a
  // configuration is also created. Building `configs` from `merged` instead of `stored` would pass
  // every case above (each is either a reuse with merged !== stored, or a create with the two equal)
  // and still copy the detected configuration into the store, where it would hide behind its own copy
  // on the next load.
  it('builds configs from stored, not merged, when merged also holds an unrelated detected configuration', () => {
    const storedTmp = tmp('t1', 'a.py')
    const detected = py('seed:python:other.py', 'other.py')
    const stored = [storedTmp]
    const merged = [storedTmp, detected]
    const r = planFileRun({ merged, stored, relPath: 'f.py', newId })
    expect(r?.configs).toEqual([storedTmp, { id: 'new:1', name: 'f.py', type: 'python', file: 'f.py', temporary: true }])
  })

  // The other half of the same rule: the name-collision check must read `merged`, not `stored` — a
  // detected configuration's name has to be able to force the relative-path fallback even though it
  // is not in `stored`.
  it('checks the name collision against merged, not stored', () => {
    const storedTmp = tmp('t1', 'a.py')
    const detected = py('seed:python:other/f.py', 'other/f.py', { name: 'f.py' })
    const stored = [storedTmp]
    const merged = [storedTmp, detected]
    const r = planFileRun({ merged, stored, relPath: 'scripts/f.py', newId })
    expect(r?.configs?.[1]).toMatchObject({ name: 'scripts/f.py' })
  })
})
