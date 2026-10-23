// The Host's record of the tokens each session spent, by whom it spent them for (observe mode design §10): kept in
// memory and in <profile>/token-totals.json, so a Host restart keeps the totals, and pruned with the Runs it counts for.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import type { Dispatch } from '../../core/orchestration/types'
import { openTokenStore } from './store'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const tempDir = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-tokens-'))
  dirs.push(d)
  return d
}
const fileIn = (profileDir: string): string => path.join(profileDir, 'token-totals.json')

const dispatch = (id: string): Dispatch => ({
  id,
  taskId: 't1',
  provider: 'claude',
  accountId: 'acc1',
  sessionId: 's',
  cwd: 'D:/p',
  specPath: 'D:/p/s.md',
  startedAt: 'T',
  workerState: 'ready',
  retained: false
})
const stateWith = (dispatchIds: string[], runIds: string[]): OrchState => ({
  ...emptyState(),
  runs: runIds.map((id) => ({ id, jobId: 'job_1', ordinal: 1, createdAt: 'T' })),
  dispatches: dispatchIds.map(dispatch)
})

describe('openTokenStore', () => {
  it('adds up what a session spent for its owner, and a new Host reads it back', async () => {
    const profileDir = await tempDir()
    const store = await openTokenStore({ profileDir, state: () => null, log: () => {} })
    store.add('sess_a', { dispatchId: 'd1' }, { input: 100, output: 10 })
    store.add('sess_a', { dispatchId: 'd1' }, { input: 50, output: 5 })
    store.add('sess_b', { dispatchId: 'd1' }, { input: 7, output: 1 })
    store.add('sess_k', { coordinatorOf: 'run_1' }, { input: 3, output: 3 })
    await store.save()
    const again = await openTokenStore({ profileDir, state: () => null, log: () => {} })
    expect(again.spent()).toEqual([
      { sessionId: 'sess_a', dispatchId: 'd1', input: 150, output: 15 },
      { sessionId: 'sess_b', dispatchId: 'd1', input: 7, output: 1 },
      { sessionId: 'sess_k', coordinatorOf: 'run_1', input: 3, output: 3 }
    ])
  })

  it('writes nothing until a session has spent something', async () => {
    const profileDir = await tempDir()
    const store = await openTokenStore({ profileDir, state: () => null, log: () => {} })
    store.add('sess_a', { dispatchId: 'd1' }, { input: 0, output: 0 })
    await store.save()
    await expect(fs.stat(fileIn(profileDir))).rejects.toThrow()
  })

  // Pruned with the Run TTL: what the state no longer holds is gone from it, and an unloaded state says nothing
  it('drops what counted for a Dispatch or a Run the state no longer holds, and nothing while the state is not known', async () => {
    const profileDir = await tempDir()
    let state: OrchState | null = null
    const store = await openTokenStore({ profileDir, state: () => state, log: () => {} })
    store.add('sess_a', { dispatchId: 'd1' }, { input: 1, output: 1 })
    store.add('sess_b', { dispatchId: 'd_gone' }, { input: 1, output: 1 })
    store.add('sess_k', { coordinatorOf: 'run_1' }, { input: 1, output: 1 })
    store.add('sess_l', { coordinatorOf: 'run_gone' }, { input: 1, output: 1 })
    await store.save()
    expect(store.spent()).toHaveLength(4)
    state = stateWith(['d1'], ['run_1'])
    await store.save()
    expect(store.spent().map((e) => e.sessionId)).toEqual(['sess_a', 'sess_k'])
    const again = await openTokenStore({ profileDir, state: () => null, log: () => {} })
    expect(again.spent().map((e) => e.sessionId)).toEqual(['sess_a', 'sess_k'])
  })

  it('starts afresh from a damaged file, keeping a copy of it beside', async () => {
    const profileDir = await tempDir()
    await fs.writeFile(fileIn(profileDir), '{"version":1,"spent":[{"sessionId":', 'utf8')
    const logs: string[] = []
    const store = await openTokenStore({ profileDir, state: () => null, log: (m) => logs.push(m) })
    expect(store.spent()).toEqual([])
    expect(await fs.readFile(`${fileIn(profileDir)}.bak`, 'utf8')).toBe('{"version":1,"spent":[{"sessionId":')
    expect(logs.join('\n')).toMatch(/damaged/)
    store.add('sess_a', { dispatchId: 'd1' }, { input: 2, output: 1 })
    await store.save()
    expect(JSON.parse(await fs.readFile(fileIn(profileDir), 'utf8'))).toEqual({
      version: 1,
      spent: [{ sessionId: 'sess_a', dispatchId: 'd1', input: 2, output: 1 }]
    })
  })
})
