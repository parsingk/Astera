import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { coordinatorReleaseOf, deferCoordinatorRelease, PendingCoordinatorReleases } from './releaseDefer'
import { EXIT_DEFER_MS } from './exitOwner'
import { OrchRollTap } from './rollTap'
import type { OrchServerDeps } from '../command'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../../sessions/pty'
import {
  attachCoordinator,
  createJob,
  emptyState,
  startJobRun,
  type OrchState
} from '../state'

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
    stop: () => void
  } => {
    const box = { state: withSlot() }
    const deps = {
      getState: () => box.state,
      setState: async (next: OrchState) => {
        box.state = next
      },
      now: () => NOW
    } as unknown as OrchServerDeps
    // ipc's `releaseCoordinator`, minus its `if (!orch) return`: the decision is the shared one.
    const release = async (sessionId: string, exitCode: number): Promise<void> => {
      const released = coordinatorReleaseOf(box.state, sessionId, exitCode)
      if (released) box.state = released.state
    }
    const pending = new PendingCoordinatorReleases()
    return {
      box,
      tap: new OrchRollTap(deps),
      exit: (sessionId, exitCode) => pending.defer(release, { sessionId, exitCode }),
      stop: () => pending.cancelAll()
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
  it('an exit that only says the app lost sight of the coordinator keeps its slot', async () => {
    const h = harness()
    h.exit('coord-old', PTY_LOST_SIGHT_EXIT_CODE)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS + 1)
    expect(h.box.state.runs[0].coordinatorSessionId).toBe('coord-old')
  })
  it('a release still pending when the server stops never runs', async () => {
    const h = harness()
    h.exit('coord-old', 1)
    h.stop()
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS + 1)
    expect(h.box.state.runs[0].coordinatorSessionId).toBe('coord-old')
  })
})

describe('PendingCoordinatorReleases (review I1: stop cancels what is pending)', () => {
  it('cancelAll drops every release still waiting, so none runs after the server stopped', async () => {
    const release = vi.fn(async () => {})
    const pending = new PendingCoordinatorReleases()
    pending.defer(release, { sessionId: 'c1', exitCode: 1 })
    pending.defer(release, { sessionId: 'c2', exitCode: 0 })
    expect(pending.size).toBe(2)
    pending.cancelAll()
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS + 1)
    expect(release).not.toHaveBeenCalled()
    expect(pending.size).toBe(0)
  })
  it('a release that fired leaves nothing pending behind it', async () => {
    const release = vi.fn(async () => {})
    const pending = new PendingCoordinatorReleases()
    pending.defer(release, { sessionId: 'c1', exitCode: 1 })
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS + 1)
    expect(release).toHaveBeenCalledWith('c1', 1)
    expect(pending.size).toBe(0)
  })
  it('deferCoordinatorRelease’s cancel handle stops that one release', async () => {
    const release = vi.fn(async () => {})
    const cancel = deferCoordinatorRelease(release, { sessionId: 'c1', exitCode: 1 })
    cancel()
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS + 1)
    expect(release).not.toHaveBeenCalled()
  })
})

describe('coordinatorReleaseOf (the release decision ipc and the Host share the rule of)', () => {
  const NOW = '2026-09-25T00:00:00.000Z'
  const seeded = (): { s: OrchState; runId: string } => {
    const planned = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW)
    if (!planned.ok) throw new Error(planned.error)
    const started = startJobRun(planned.state, planned.value.id, NOW)
    if (!started.ok) throw new Error(started.error)
    const attached = attachCoordinator(started.state, { runId: started.value.id, sessionId: 'c1' })
    if (!attached.ok) throw new Error(attached.error)
    return { s: attached.state, runId: started.value.id }
  }
  it('empties the slot of the Run the exited session coordinated', () => {
    const { s, runId } = seeded()
    const r = coordinatorReleaseOf(s, 'c1', 1)
    expect(r?.run.id).toBe(runId)
    expect(r?.state.runs[0].coordinatorSessionId).toBeUndefined()
  })
  it('keeps the slot on a lost-sight exit, and names nothing for a session no Run holds', () => {
    const { s } = seeded()
    expect(coordinatorReleaseOf(s, 'c1', PTY_LOST_SIGHT_EXIT_CODE)).toBeNull()
    expect(coordinatorReleaseOf(s, 'other', 1)).toBeNull()
  })
})
