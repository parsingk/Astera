import { describe, it, expect } from 'vitest'
import { LOCAL, isRemoteRuntime, offlineNote, projectOptions, remoteDetailKey, remotePollReady, runtimeOptions } from './remoteJobs'
import type { OrchSnapshot } from '../../../core/types'

const t = (key: string, params?: Record<string, unknown>): string => `${key}${params ? ` ${JSON.stringify(params)}` : ''}`

describe('the remote Jobs view (remote runtime design Phase 6)', () => {
  it('offers this computer first, then each paired Runtime by name', () => {
    expect(runtimeOptions([{ runtimeId: 'rt_a', name: 'Office' }, { runtimeId: 'rt_b', name: 'Build' }], t)).toEqual([
      { value: LOCAL, label: 'jobs.runtime.local' },
      { value: 'rt_a', label: 'Office' },
      { value: 'rt_b', label: 'Build' }
    ])
  })
  it("lists the Runtime's projects by name, then unregistered folders last", () => {
    expect(projectOptions([{ id: 'p1', name: 'repo', path: '/srv/repo' }, { id: 'unregistered', name: null, path: null }], t)).toEqual([
      { value: 'p1', label: 'repo' },
      { value: 'unregistered', label: 'jobs.runtime.unregistered' }
    ])
  })
  it('only a paired Runtime is remote', () => {
    expect(isRemoteRuntime(LOCAL)).toBe(false)
    expect(isRemoteRuntime('rt_a')).toBe(true)
  })
  it('offline says it may still be running, with when it was last seen, and never failed; online says nothing', () => {
    const note = offlineNote({ runtimeId: 'rt_a', offline: true, stale: true, version: 3 }, 'Office', '2026-10-08T01:02:03.000Z', t, (iso) => `at ${iso}`)
    expect(note).toBe('jobs.runtime.offline {"name":"Office"} jobs.runtime.lastSeen {"at":"at 2026-10-08T01:02:03.000Z"}')
    expect(note).not.toMatch(/fail/i)
    expect(offlineNote({ runtimeId: 'rt_a', offline: false, stale: false, version: 3 }, 'Office', null, t, (iso) => iso)).toBeNull()
    expect(offlineNote(undefined, 'Office', null, t, (iso) => iso)).toBeNull()
  })
})

// Phase 6 review minors.
describe('the remote Jobs view, review minors', () => {
  it('marks a paired Runtime that did not answer the last time it was asked', () => {
    expect(runtimeOptions([{ runtimeId: 'rt_a', name: 'Office', offline: true }, { runtimeId: 'rt_b', name: 'Build', offline: false }], t)).toEqual([
      { value: LOCAL, label: 'jobs.runtime.local' },
      { value: 'rt_a', label: 'jobs.runtime.optionOffline {"name":"Office"}' },
      { value: 'rt_b', label: 'Build' }
    ])
  })
  it("polls a Runtime only with that Runtime's own project, never the last Runtime's", () => {
    const base = { open: true, runtimeId: 'rt_b', project: 'p1', projectFor: 'rt_b' }
    expect(remotePollReady(base)).toBe(true)
    expect(remotePollReady({ ...base, projectFor: 'rt_a' })).toBe(false)
    expect(remotePollReady({ ...base, project: null })).toBe(false)
    expect(remotePollReady({ ...base, open: false })).toBe(false)
    expect(remotePollReady({ ...base, runtimeId: LOCAL, projectFor: LOCAL })).toBe(false)
  })
  it("a remote detail is asked again only when its own row or the Runtime's reach changes", () => {
    const row = (id: string, eventCount: number) => ({ id, objective: id, status: 'running', eventCount }) as unknown as OrchSnapshot['runs'][number]
    const snap = (rows: OrchSnapshot['runs'], offline = false): OrchSnapshot =>
      ({ runs: rows, projectFolderBusy: false, runtime: { runtimeId: 'rt_a', offline, stale: false, version: 1 } }) as OrchSnapshot
    const a = remoteDetailKey(snap([row('run_1', 3), row('run_2', 1)]), 'run_1')
    expect(remoteDetailKey(snap([row('run_1', 3), row('run_2', 9)]), 'run_1')).toBe(a)
    expect(remoteDetailKey(snap([row('run_1', 4), row('run_2', 1)]), 'run_1')).not.toBe(a)
    expect(remoteDetailKey(snap([row('run_1', 3), row('run_2', 1)], true), 'run_1')).not.toBe(a)
    expect(remoteDetailKey(null, 'run_1')).toBe('none')
  })
})
