import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { deferCoordinatorRelease } from './releaseDefer'
import { EXIT_DEFER_MS } from '../../core/orchestration/exec/exitOwner'
import { OrchRollTap } from '../../core/orchestration/exec/rollTap'
import type { OrchServerDeps } from '../../core/orchestration/command'
import {
  attachCoordinator,
  createJob,
  detachCoordinator,
  emptyState,
  startJobRun,
  type OrchState
} from '../../core/orchestration/state'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('deferCoordinatorRelease (S6 R14, the app half)', () => {
  it('releases the slot only after the roll window, so a roll’s rekey lands first', async () => {
    const release = vi.fn(async () => {})
    deferCoordinatorRelease(release, { sessionId: 'c1', exitCode: 1 })
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS - 1)
    expect(release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(release).toHaveBeenCalledWith('c1', 1)
  })
  it('a release that rejects is swallowed, never an unhandled rejection', async () => {
    const seen: unknown[] = []
    const on = (e: unknown): void => { seen.push(e) }
    process.on('unhandledRejection', on)
    try {
      deferCoordinatorRelease(async () => { throw new Error('boom') }, { sessionId: 'c1', exitCode: 1 }, () => {})
      await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS + 1)
      await Promise.resolve()
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', on)
    }
  })
})

// The two halves together, over one state: the core tap's rekey and the deferred release. `release`
// here is `releaseCoordinator`'s body in ipc.ts (find the Run by its slot, detachCoordinator), so what
// changes is only when it runs. A coordinator that really exits, or that a person stops by closing its
// tab (an exit through the same `onSessionExit`), is never rolled: its slot still empties.
describe('deferCoordinatorRelease with the roll tap (S6 R14)', () => {
  const NOW = '2026-09-25T00:00:00.000Z'
  const withSlot = (): OrchState => {
    const planned = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW)
    if (!planned.ok) throw new Error(planned.error)
    const started = startJobRun(planned.state, planned.value.id, NOW)
    if (!started.ok) throw new Error(started.error)
    const attached = attachCoordinator(started.state, { runId: started.value.id, sessionId: 'coord-old' })
    if (!attached.ok) throw new Error(attached.error)
    return attached.state
  }
  const harness = (): {
    box: { state: OrchState }
    tap: OrchRollTap
    exit: (sessionId: string, exitCode: number) => void
  } => {
    const box = { state: withSlot() }
    const deps = {
      getState: () => box.state,
      setState: async (next: OrchState) => {
        box.state = next
      },
      now: () => NOW
    } as unknown as OrchServerDeps
    const release = async (sessionId: string): Promise<void> => {
      const run = box.state.runs.find((r) => r.coordinatorSessionId === sessionId)
      if (!run) return
      const detached = detachCoordinator(box.state, { runId: run.id })
      if (detached.ok) box.state = detached.state
    }
    return {
      box,
      tap: new OrchRollTap(deps),
      exit: (sessionId, exitCode) => deferCoordinatorRelease(release, { sessionId, exitCode })
    }
  }

  it('a rolled coordinator keeps its Run’s slot, the exit arriving before the roll notice', async () => {
    const h = harness()
    h.exit('coord-old', 1)
    await h.tap.onRolled('coord-old', { id: 'coord-new', accountId: 'acc1' })
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS + 1)
    expect(h.box.state.runs[0].coordinatorSessionId).toBe('coord-new')
  })
  it('a rolled coordinator keeps its Run’s slot, the roll notice arriving first', async () => {
    const h = harness()
    await h.tap.onRolled('coord-old', { id: 'coord-new', accountId: 'acc1' })
    h.exit('coord-old', 1)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS + 1)
    expect(h.box.state.runs[0].coordinatorSessionId).toBe('coord-new')
  })
  it('a coordinator that really exits still releases its slot, after the window', async () => {
    const h = harness()
    h.exit('coord-old', 1)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS - 1)
    expect(h.box.state.runs[0].coordinatorSessionId).toBe('coord-old')
    await vi.advanceTimersByTimeAsync(2)
    expect(h.box.state.runs[0].coordinatorSessionId).toBeUndefined()
  })
  it('a coordinator a person stops still releases its slot', async () => {
    const h = harness()
    h.exit('coord-old', 0)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS + 1)
    expect(h.box.state.runs[0].coordinatorSessionId).toBeUndefined()
  })
})
