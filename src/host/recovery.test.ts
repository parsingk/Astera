import { describe, it, expect } from 'vitest'
import { createHostRecovery, type HostRecoveryDeps } from './recovery'
import { stateFromLegacy } from '../core/orchestration/legacyState'
import type { OrchState } from '../core/orchestration/state'
import type { Dispatch, Task } from '../core/orchestration/types'
import type { LegacyRun } from '../core/orchestration/legacy'
import type { GitFacts } from '../core/recovery/types'
import type { ResumeStrategy } from '../core/types'
import { HOST_YIELD_RECOVERY } from '../core/host/protocol'

const NOW = '2026-10-08T10:00:00.000Z'
const EARLIER = '2026-10-08T09:00:00.000Z'
const run = (over: Partial<LegacyRun> = {}): LegacyRun => ({ id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: EARLIER, autoDispatch: true, ...over })
const task = (over: Partial<Task> = {}): Task => ({
  id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'dispatched',
  accountIds: ['acc_1'], consecutiveFailures: 0, createdAt: EARLIER, updatedAt: EARLIER, ...over
})
const lost = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc_1', sessionId: 'sess-1',
  cwd: 'D:/wt', specPath: 'D:/spec.md', startedAt: EARLIER, workerState: 'outcome_unknown',
  endedAt: NOW, retained: false, ...over
})
const lostState = (): OrchState => stateFromLegacy({ runs: [run()], tasks: [task()], dispatches: [lost()] })

/** A Host recovery whose journal, git, executor and orch are recorded fakes. */
function rig(over: {
  events?: Array<{ type: string; dispatchId: string }>
  hasApp?: boolean
  keeps?: boolean
  writes?: boolean
  mayStart?: () => boolean
  gitGate?: Promise<void>
  strategy?: () => ResumeStrategy
  dirty?: boolean
  state?: OrchState
} = {}) {
  let current = over.state ?? lostState()
  const appended: Array<{ type: string }> = []
  const executed: Array<{ dispatchId: string; strategy: string }> = []
  const handled: Array<{ cmd: string; args: Record<string, unknown> }> = []
  const logs: string[] = []
  const box = { mayStart: over.mayStart ?? (() => true), keeps: over.keeps ?? false, writes: over.writes ?? true }
  const deps: HostRecoveryDeps = {
    journal: {
      writes: () => box.writes,
      reconcilerJournal: {
        eventsFor: () => (over.events ?? [{ type: 'PROMPT_WRITE_CONFIRMED', dispatchId: 'dsp_1' }]) as never,
        firstCheckpointFor: () => ({ gitHead: 'aaa' }) as never,
        append: (events) => { appended.push(...events); return events.length },
        startRecoveryAction: (r) => ({ recoveryActionId: 'rca_1', status: 'selected', startedAt: r.at, completedAt: null, details: null, ...r }) as never,
        finishRecoveryAction: () => {}
      }
    },
    server: { hasApp: () => over.hasApp ?? false, appsKeep: (duty) => duty === HOST_YIELD_RECOVERY && box.keeps },
    mayStart: () => box.mayStart(),
    orch: {
      internalDeps: () => ({ getState: () => current, setState: async (n: OrchState) => { current = n }, startWorker: async () => { throw new Error('not here') } }) as never,
      handle: async (cmd, args) => { handled.push({ cmd, args }); return { status: 200, body: {} } },
      state: () => current
    },
    checks: { startValidation: () => {}, langNow: () => 'en' },
    profileDir: 'D:/profile',
    log: (m) => logs.push(m),
    now: () => NOW,
    readGitFacts: async (): Promise<GitFacts> => {
      if (over.gitGate) await over.gitGate
      return { exists: true, head: 'aaa', dirty: over.dirty ?? false, inProgress: null, conflicts: false, branch: 'main' } as GitFacts
    },
    readResumeStrategy: async () => (over.strategy ? over.strategy() : 'original'),
    executeRecovery: async (a) => {
      executed.push({ dispatchId: a.attempt.dispatchId, strategy: a.decision.strategy })
      current = { ...current, dispatches: [...current.dispatches, lost({ id: 'dsp_2', sessionId: 'sess-2', startedAt: NOW, endedAt: undefined, workerState: 'ready', retryOf: 'dsp_1' })] }
      return { ok: true as const, newDispatchId: 'dsp_2' }
    }
  }
  return { r: createHostRecovery(deps), box, appended, executed, handled, logs, set: (f: (s: OrchState) => OrchState) => { current = f(current) } }
}

describe('createHostRecovery (remote runtime design §2.6, Phase 3R)', () => {
  it('owns recovery only while it may start, writes the journal, and no app keeps recovery', () => {
    const h = rig()
    expect(h.r.owns()).toBe(true)
    h.box.mayStart = () => false
    expect(h.r.owns()).toBe(false)
    h.box.mayStart = () => true
    h.box.writes = false
    expect(h.r.owns()).toBe(false)
    h.box.writes = true
    h.box.keeps = true
    expect(h.r.owns()).toBe(false)
  })

  it('the sweep decides and executes a lost attempt once, journalled', async () => {
    const h = rig()
    await Promise.all([h.r.sweep('a test'), h.r.sweep('a test')])
    expect(h.executed).toEqual([{ dispatchId: 'dsp_1', strategy: 'redispatch' }])
    expect(h.appended.map((e) => e.type)).toEqual(expect.arrayContaining(['RECOVERY_DETECTED', 'RECOVERY_STRATEGY_SELECTED', 'RECOVERY_COMPLETED']))
  })

  it('a lost worker event recovers that one Dispatch', async () => {
    const h = rig()
    h.r.lost('dsp_1')
    await expect.poll(() => h.executed.length).toBe(1)
  })

  it('does nothing at all when it does not own recovery', async () => {
    const h = rig({ keeps: true })
    await h.r.sweep('a test')
    h.r.lost('dsp_1')
    await new Promise((r) => setImmediate(r))
    expect(h.executed).toEqual([])
    expect(h.appended).toEqual([])
  })

  it('refuses to execute once it stopped owning recovery between the decision and the start', async () => {
    let release!: () => void
    const gitGate = new Promise<void>((r) => (release = r))
    const h = rig({ gitGate })
    const sweeping = h.r.sweep('a test')
    await new Promise((r) => setImmediate(r))
    h.box.mayStart = () => false
    release()
    await sweeping
    expect(h.executed).toEqual([])
    expect(h.appended.map((e) => e.type)).toContain('RECOVERY_FAILED')
  })

  it('gates an unwitnessed lost attempt in a Run with no coordinator when no app is attached', async () => {
    const h = rig({ events: [] })
    await h.r.sweep('a test')
    expect(h.executed).toEqual([])
    expect(h.handled).toEqual([{ cmd: 'gate-create', args: { task: 'tsk_1', question: expect.stringContaining('dsp_1') } }])
  })

  it('leaves an unwitnessed lost attempt alone while an app is attached', async () => {
    const h = rig({ events: [], hasApp: true })
    await h.r.sweep('a test')
    expect(h.handled).toEqual([])
  })

  // Unfinished work in the worktree: Smart Resume on resumes from a briefing, off asks a person.
  it('reads the resume strategy at each trigger', async () => {
    let strategy: ResumeStrategy = 'original'
    const h = rig({ strategy: () => strategy, dirty: true })
    strategy = 'smart'
    await h.r.sweep('a test')
    expect(h.executed).toEqual([{ dispatchId: 'dsp_1', strategy: 'smart-resume' }])
  })

  // Final review C1: the scheduler may fill the lost worker's slot first; the Host asks again once room frees.
  it('a candidate left for lack of room is recovered at a later catch-up, once its Run has room', async () => {
    const busy = stateFromLegacy({
      runs: [run({ concurrency: 1 })],
      tasks: [task(), task({ id: 'tsk_2' })],
      dispatches: [lost(), lost({ id: 'dsp_open', taskId: 'tsk_2', sessionId: 'sess-9', endedAt: undefined, workerState: 'ready' })]
    })
    const h = rig({ state: busy })
    await h.r.sweep('a test')
    expect(h.executed).toEqual([])
    await h.r.catchUp()
    expect(h.executed).toEqual([])
    h.set((s) => ({ ...s, dispatches: s.dispatches.map((d) => (d.id === 'dsp_open' ? { ...d, endedAt: NOW, outcome: 'succeeded' } : d)) }))
    await h.r.catchUp()
    expect(h.executed).toEqual([{ dispatchId: 'dsp_1', strategy: 'redispatch' }])
    await h.r.catchUp()
    expect(h.executed).toHaveLength(1)
  })

  it('catchUp waits for a recovery in flight, so the scheduler fills no slot before it', async () => {
    let release!: () => void
    const gitGate = new Promise<void>((r) => (release = r))
    const h = rig({ gitGate })
    void h.r.sweep('a test')
    h.r.lost('dsp_1')
    let caught = false
    const c = h.r.catchUp().then(() => (caught = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(caught).toBe(false)
    release()
    await c
    expect(h.executed).toHaveLength(1)
  })

  it('catchUp does nothing while the Host does not own recovery', async () => {
    const busy = stateFromLegacy({
      runs: [run({ concurrency: 1 })],
      tasks: [task(), task({ id: 'tsk_2' })],
      dispatches: [lost(), lost({ id: 'dsp_open', taskId: 'tsk_2', sessionId: 'sess-9', endedAt: undefined, workerState: 'ready' })]
    })
    const h = rig({ state: busy })
    await h.r.sweep('a test')
    h.set((s) => ({ ...s, dispatches: s.dispatches.map((d) => (d.id === 'dsp_open' ? { ...d, endedAt: NOW, outcome: 'succeeded' } : d)) }))
    h.box.keeps = true
    await h.r.catchUp()
    expect(h.executed).toEqual([])
  })
})
