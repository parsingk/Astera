import { describe, it, expect, vi } from 'vitest'
import { askHostCoordinatorIdle } from './coordinatorIdle'
import { HOST_FEATURE_COORDINATOR_IDLE } from '../../core/host/protocol'
import { handleCommand, type OrchServerDeps } from '../../core/orchestration/command'
import { emptyState, type OrchState } from '../../core/orchestration/state'

const connected = { connected: true, features: [HOST_FEATURE_COORDINATOR_IDLE] }

describe('askHostCoordinatorIdle (final round 3)', () => {
  it('answers what the Host says, through the app-only coordinator-idle call', async () => {
    const call = vi.fn(async () => ({ status: 200, body: { idle: true } }))
    expect(await askHostCoordinatorIdle({ status: () => connected, call }, 'run_1', 'ses_c')).toBe(true)
    expect(call).toHaveBeenCalledWith({ cmd: 'coordinator-idle', args: { runId: 'run_1', sessionId: 'ses_c' }, sessionId: '' })
    const no = vi.fn(async () => ({ status: 200, body: { idle: false } }))
    expect(await askHostCoordinatorIdle({ status: () => connected, call: no }, 'run_1', 'ses_c')).toBe(false)
  })

  it('is unknown, and asks nothing, when the Host did not announce the feature or is not connected', async () => {
    const call = vi.fn(async () => ({ status: 200, body: { idle: true } }))
    expect(await askHostCoordinatorIdle({ status: () => ({ connected: true, features: [] }), call }, 'r', 's')).toBeNull()
    expect(await askHostCoordinatorIdle({ status: () => ({ ...connected, connected: false }), call }, 'r', 's')).toBeNull()
    expect(await askHostCoordinatorIdle({ status: () => null, call }, 'r', 's')).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it('is unknown when the call fails, runs out its deadline, or answers anything else', async () => {
    const log = vi.fn()
    const rejects = async () => {
      throw new Error('the Host did not answer coordinator-idle within 30000ms')
    }
    expect(await askHostCoordinatorIdle({ status: () => connected, call: rejects, log }, 'r', 's')).toBeNull()
    expect(log.mock.calls.join('\n')).toContain('did not answer')
    expect(await askHostCoordinatorIdle({ status: () => connected, call: async () => ({ status: 501, body: {} }) }, 'r', 's')).toBeNull()
    expect(await askHostCoordinatorIdle({ status: () => connected, call: async () => ({ status: 200, body: { idle: 'yes' } }) }, 'r', 's')).toBeNull()
  })
})

// The app drives: its fire runs the command layer here, and asks the Host whether the coordinator of a
// Run that has only its coordinator left is parked in check --wait.
describe('an app-driven fire asks the Host (final round 3)', () => {
  const appDeps = (host: { features: string[]; idle?: boolean }) => {
    let state: OrchState = emptyState()
    const stopped: string[] = []
    const deps = {
      getState: () => state,
      setState: async (next: OrchState) => {
        state = next
      },
      now: () => '2026-08-04T00:00:00.000Z',
      listAccounts: () => [{ id: 'accA', label: 'A', provider: 'claude' as const }],
      startCoordinator: async (a: { runId: string }) => ({ sessionId: `coord-${a.runId}` }),
      stopCoordinator: async (id: string) => {
        stopped.push(id)
      },
      coordinatorIdle: (runId: string, sessionId: string) =>
        askHostCoordinatorIdle(
          { status: () => ({ connected: true, features: host.features }), call: async () => ({ status: 200, body: { idle: host.idle } }) },
          runId,
          sessionId
        ),
      log: () => {}
    } as unknown as OrchServerDeps
    return { deps, stopped, runs: () => state.runs }
  }
  const call = (deps: OrchServerDeps, cmd: string, args: Record<string, unknown>) =>
    handleCommand(deps, { sessionId: 'astera:app' }, cmd, args)
  const firedTwice = async (host: { features: string[]; idle?: boolean }) => {
    const a = appDeps(host)
    const r = await call(a.deps, 'run-create', { objective: 'o', cwd: 'D:/p', auto: true, coordinatorAccount: 'accA', schedule: { kind: 'daily', time: '09:00' } })
    const jobId = (r.body as { id: string }).id
    await call(a.deps, 'run-start', { run: jobId })
    const first = (await call(a.deps, 'run-spawn', { run: jobId, unlessRunning: true })).body as { id: string }
    const second = await call(a.deps, 'run-spawn', { run: jobId, unlessRunning: true })
    return { ...a, first: first.id, second }
  }

  it('replaces the Run when the Host says its coordinator is idle', async () => {
    const r = await firedTwice({ features: [HOST_FEATURE_COORDINATOR_IDLE], idle: true })
    expect(r.second.status).toBe(200)
    expect(r.stopped).toEqual([`coord-${r.first}`])
    expect(r.runs().find((x) => x.id === r.first)?.paused).toBe(true)
  })

  it('skips when the Host says it is not idle', async () => {
    const r = await firedTwice({ features: [HOST_FEATURE_COORDINATOR_IDLE], idle: false })
    expect(r.second.status).toBe(409)
    expect(r.stopped).toEqual([])
  })

  it('skips when the Host did not announce coordinator-idle', async () => {
    const r = await firedTwice({ features: [], idle: true })
    expect(r.second.status).toBe(409)
    expect(r.stopped).toEqual([])
  })
})
