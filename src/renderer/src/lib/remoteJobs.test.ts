import { describe, it, expect } from 'vitest'
import { LOCAL, isRemoteRuntime, offlineNote, projectOptions, runtimeOptions } from './remoteJobs'

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
