import { describe, it, expect } from 'vitest'
import { createOrchRouter, type OrchHandlers } from './orchRouter'
import type { RemoteRuntimeClient } from './runtimeClient'

/** Local handlers that record each call: what today's ipc.ts bodies are, with their guards inside. */
const recordingLocal = () => {
  const calls: Array<{ name: string; args: unknown[] }> = []
  const local: OrchHandlers = {
    list: async (...args) => (calls.push({ name: 'list', args }), { runs: [], projectFolderBusy: false }),
    runDetail: async (...args) => (calls.push({ name: 'runDetail', args }), { events: [], layers: [], deps: {}, cyclic: [] }),
    completion: async (...args) => (calls.push({ name: 'completion', args }), null),
    command: async (...args) => (calls.push({ name: 'command', args }), { status: 200, body: { local: true } })
  }
  return { local, calls }
}

const fakeClient = (): RemoteRuntimeClient & { seen: string[] } => {
  const seen: string[] = []
  return {
    seen,
    runtimeId: 'rt_a',
    mirror: () => ({ state: null, version: 0, bootId: null, offline: false, stale: false, at: null }),
    refresh: async () => ({ state: null, version: 0, bootId: null, offline: false, stale: false, at: null }),
    list: async (p) => (seen.push(`list:${p}`), { runs: [], projectFolderBusy: false, runtime: { runtimeId: 'rt_a', offline: false, stale: false, version: 1 } }),
    runDetail: async (r) => (seen.push(`runDetail:${r}`), { events: [], layers: [], deps: {}, cyclic: [] }),
    completion: async (r, t) => (seen.push(`completion:${r}:${t}`), null),
    command: async (c) => (seen.push(`command:${c}`), { status: 200, body: { remote: true } }),
    close: () => {}
  }
}

describe('createOrchRouter (remote runtime design §2.7, D1.1, D1.6, D1.7)', () => {
  it("sends a call with no runtime, or 'local', to the local handlers exactly as given", async () => {
    const l = recordingLocal()
    const client = fakeClient()
    const r = createOrchRouter({ local: l.local, remote: { client: async () => client } })
    await r.list('/p')
    await r.list('/p', 'local')
    await r.runDetail('/p', 'run_1', { journalPages: 2 })
    await r.completion('/p', 'run_1', 'tsk_1', 'local')
    expect(await r.command('/p', 'jobs-run', { id: 'j' })).toEqual({ status: 200, body: { local: true } })
    expect(l.calls.map((c) => c.name)).toEqual(['list', 'list', 'runDetail', 'completion', 'command'])
    expect(l.calls[0].args).toEqual(['/p'])
    expect(l.calls[2].args).toEqual(['/p', 'run_1', { journalPages: 2 }])
    expect(client.seen).toEqual([])
  })

  it('sends a remote call to its client only: no local handler, so no guard and no project registration', async () => {
    const l = recordingLocal()
    const client = fakeClient()
    const r = createOrchRouter({ local: l.local, remote: { client: async () => client } })
    expect(await r.list('/srv/repo', 'rt_a')).toMatchObject({ runtime: { runtimeId: 'rt_a' } })
    await r.runDetail('/srv/repo', 'run_1', undefined, 'rt_a')
    await r.completion('/srv/repo', 'run_1', 'tsk_1', 'rt_a')
    expect(await r.command('/srv/repo', 'jobs-run', { id: 'j' }, 'rt_a')).toEqual({ status: 200, body: { remote: true } })
    expect(client.seen).toEqual(['list:/srv/repo', 'runDetail:run_1', 'completion:run_1:tsk_1', 'command:jobs-run'])
    expect(l.calls).toEqual([])
  })

  it('a runtime nobody paired answers on its own, and the local handlers still answer', async () => {
    const l = recordingLocal()
    const r = createOrchRouter({ local: l.local, remote: { client: async () => ({ code: 'RUNTIME_NOT_FOUND', message: 'no such runtime' }) } })
    expect(await r.list('/p', 'rt_x')).toEqual({ runs: [], projectFolderBusy: false, runtime: { runtimeId: 'rt_x', offline: true, stale: false, version: 0 } })
    expect(await r.runDetail('/p', 'run_1', undefined, 'rt_x')).toEqual({ events: [], layers: [], deps: {}, cyclic: [] })
    expect(await r.completion('/p', 'run_1', 't', 'rt_x')).toBeNull()
    expect(await r.command('/p', 'jobs-run', {}, 'rt_x')).toEqual({ status: 404, body: { error: 'no such runtime', code: 'RUNTIME_NOT_FOUND' } })
    expect(l.calls).toEqual([])
    await r.list('/p')
    expect(l.calls.map((c) => c.name)).toEqual(['list'])
  })

  it('a remote client that throws does not reach the local handlers, and answers as offline', async () => {
    const l = recordingLocal()
    const broken = { ...fakeClient(), list: async () => { throw new Error('boom') }, command: async () => { throw new Error('boom') } }
    const r = createOrchRouter({ local: l.local, remote: { client: async () => broken } })
    expect(await r.list('/p', 'rt_a')).toMatchObject({ runs: [], runtime: { runtimeId: 'rt_a', offline: true } })
    expect(await r.command('/p', 'jobs-run', {}, 'rt_a')).toMatchObject({ status: 503, body: { code: 'RUNTIME_OFFLINE' } })
    expect(l.calls).toEqual([])
  })
})
