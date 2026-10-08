// The Host's own git record is the Host's alone (Phase 10 review): a socket that names itself `astera:host` would pass
// `runs-git-record`'s check, so that call from outside under that id is refused.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch } from './orch'
import { emptyState } from '../core/orchestration/state'
import { HOST_CALLER } from '../core/host/driver'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hostcaller-'))
  await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(emptyState()), 'utf8')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const orchIn = () =>
  createHostOrch({
    profileDir: dir,
    version: '9.9.9',
    now: () => new Date().toISOString(),
    hostStartedAt: () => new Date().toISOString(),
    runningSessions: () => 0,
    aliveSessionIds: () => new Set<string>(),
    act: async () => ({}),
    hasApp: () => false,
    onState: () => {},
    log: () => {},
    sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() }
  })

describe('the Host caller id over a socket', () => {
  it('is refused, and the Host’s own record stays its own', async () => {
    const orch = orchIn()
    await orch.ready()
    const runId = ((await orch.handle('run-create', { objective: 'o', cwd: dir })).body as { id: string }).id
    for (const role of ['cli', 'app', 'mcp'] as const) {
      const r = await orch.call({ cmd: 'runs-git-record', args: { runId, base: 'abcdef1' }, sessionId: HOST_CALLER, from: { role, toOthers: () => {} } as never })
      expect(r.status).toBe(403)
    }
    expect(orch.state().runs[0].git).toBeUndefined()
    expect((await orch.handle('runs-git-record', { runId, base: 'abcdef1' })).status).toBe(200)
  })
})
