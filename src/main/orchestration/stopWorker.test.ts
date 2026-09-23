import { describe, it, expect, vi } from 'vitest'
import { killWorkerSession, type KillWorkerDeps } from './stopWorker'
import { handleCommand, type OrchServerDeps } from '../../core/orchestration/command'
import { OrchCoordinator } from '../../core/orchestration/exec/coordinator'
import { releaseArgsFor } from '../../core/orchestration/exec/release'
import { createJob, createTask, emptyState, openDispatch, startJobRun, type OrchState } from '../../core/orchestration/state'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../../core/sessions/pty'
import type { PtyEntry } from '../../core/host/protocol'

const NOW = '2026-09-24T00:00:00.000Z'

const hostEntry = (over: Partial<PtyEntry> = {}): PtyEntry => ({
  id: 'p_host',
  pid: 7,
  meta: { kind: 'session', id: 'ses_host', restore: {} },
  alive: true,
  ...over
})

/** The app's side of it: `info` stands in for `core.sessions.list()`, `kill` for `core.sessions.kill`.
 *  The Host stand-in answers each `pty-kill` it is sent the way `exit` says: with its `pty-exit`
 *  (`'exits'`), or never (`'silent'`: the kill failed in the Host, or the socket dropped before the
 *  Host read it, or the exit was lost on the way back). `entries` is each `pty-list` answer in turn. */
const rig = (a: {
  app?: { status: 'running' | 'exited'; exitCode?: number }
  entries?: Array<PtyEntry[] | null>
  sent?: boolean
  host?: false
  exit?: 'exits' | 'silent'
}) => {
  const appKilled: string[] = []
  const hostKilled: string[] = []
  const logs: string[] = []
  const answers = [...(a.entries ?? [[hostEntry()], [hostEntry()]])]
  const list = vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0]))
  const exitCbs = new Map<string, () => void>()
  const d: KillWorkerDeps = {
    app: {
      info: () => a.app,
      kill: (id) => appKilled.push(id)
    },
    host:
      a.host === false
        ? null
        : {
            list,
            kill: (id) => {
              hostKilled.push(id)
              const sent = a.sent ?? true
              if (sent && (a.exit ?? 'exits') === 'exits') queueMicrotask(() => exitCbs.get(id)?.())
              return sent
            },
            onExit: (id, cb) => {
              exitCbs.set(id, cb)
              return () => exitCbs.delete(id)
            }
          },
    log: (m) => logs.push(m),
    waitMs: 20
  }
  return { d, appKilled, hostKilled, logs, list, exitCbs }
}

describe('killWorkerSession', () => {
  // After Task 14's adoption the app holds the session: its handle's kill is a `pty-kill`, so the
  // worker really ends, and the exit comes back to the app because the app sent `pty-attach`.
  it('kills a session the app holds running through the app, and asks the Host nothing', async () => {
    const h = rig({ app: { status: 'running' } })
    await killWorkerSession('ses_host', h.d)
    expect(h.appKilled).toEqual(['ses_host'])
    expect(h.list).not.toHaveBeenCalled()
  })
  // Before adoption: `core.sessions.kill` of a session the app never held does nothing at all.
  it('ends a session the app does not hold in the Host that runs it', async () => {
    const h = rig({})
    await killWorkerSession('ses_host', h.d)
    expect(h.hostKilled).toEqual(['p_host'])
    expect(h.appKilled).toEqual([])
    expect(h.logs.join('\n')).toContain('ses_host')
  })
  it('asks the Host too about a session the app only lost sight of', async () => {
    const h = rig({ app: { status: 'exited', exitCode: PTY_LOST_SIGHT_EXIT_CODE } })
    await killWorkerSession('ses_host', h.d)
    expect(h.hostKilled).toEqual(['p_host'])
  })
  it('refuses when the Host does not answer, instead of claiming the worker stopped', async () => {
    const h = rig({ entries: [null] })
    await expect(killWorkerSession('ses_host', h.d)).rejects.toThrow(/not stopped/)
    expect(h.hostKilled).toEqual([])
  })
  // Fix round I2: "the pty-kill left the app" is not "the worker ended". Only the Host's pty-exit, or a
  // pty-list that no longer shows it alive, counts as stopped.
  it('waits for the pty-exit the Host broadcasts, and does not ask again once it came', async () => {
    const h = rig({})
    await killWorkerSession('ses_host', h.d)
    expect(h.list).toHaveBeenCalledTimes(1)
    expect(h.exitCbs.size).toBe(0) // the listener was taken off again
  })
  it('refuses when the kill failed in the Host: no exit comes and the pty is still alive', async () => {
    const h = rig({ exit: 'silent' })
    await expect(killWorkerSession('ses_host', h.d)).rejects.toThrow(/not stopped/)
    expect(h.hostKilled).toEqual(['p_host'])
    expect(h.list).toHaveBeenCalledTimes(2)
  })
  it('refuses when the socket dropped before the Host read the kill', async () => {
    // The send reached the socket, the Host never saw it, and the list asked afterwards has no answer.
    const h = rig({ exit: 'silent', entries: [[hostEntry()], null] })
    await expect(killWorkerSession('ses_host', h.d)).rejects.toThrow(/not stopped/)
  })
  it('succeeds when the exit was lost but the pty is gone', async () => {
    const h = rig({ exit: 'silent', entries: [[hostEntry()], [hostEntry({ alive: false })]] })
    await killWorkerSession('ses_host', h.d)
    expect(h.hostKilled).toEqual(['p_host'])
  })
  it('refuses the first press whose check went unanswered, and the second press, finding it gone, succeeds', async () => {
    const h = rig({ exit: 'silent', entries: [[hostEntry()], null, [hostEntry({ alive: false })]] })
    await expect(killWorkerSession('ses_host', h.d)).rejects.toThrow(/not stopped/)
    await killWorkerSession('ses_host', h.d)
    expect(h.hostKilled).toEqual(['p_host']) // the second press had nothing left to kill
  })
  it('refuses when the kill could not be sent to the Host', async () => {
    const h = rig({ sent: false })
    await expect(killWorkerSession('ses_host', h.d)).rejects.toThrow(/not stopped/)
  })
  it('has nothing to kill when the Host runs no live pty for that session', async () => {
    const h = rig({ entries: [[hostEntry({ alive: false }), hostEntry({ id: 'p2', meta: { kind: 'session', id: 'ses_other', restore: {} } })]] })
    await killWorkerSession('ses_host', h.d)
    expect(h.hostKilled).toEqual([])
  })
  it('does not ask the Host about a session the app saw end', async () => {
    const h = rig({ app: { status: 'exited', exitCode: 0 } })
    await killWorkerSession('ses_host', h.d)
    expect(h.list).not.toHaveBeenCalled()
    expect(h.hostKilled).toEqual([])
  })
  it('with no Host at all, leaves it to the app as before', async () => {
    const h = rig({ host: false })
    await killWorkerSession('ses_host', h.d)
    expect(h.appKilled).toEqual(['ses_host'])
  })
})

// Task 11 review I3(c): the Stop button in RunDetail is the app's own `worker-stop`, run by
// `handleCommand` over the app's deps. Wired here the way ipc.ts wires it: `releaseArgsFor`, then the
// coordinator's `releaseWorker`, whose `killSession` is `killWorkerSession`.
describe("the app's worker-stop on a worker the Host spawned", () => {
  const withWorker = (): { state: OrchState; dispatchId: string } => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW); if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW); if (!task.ok) throw new Error(task.error)
    const dsp = openDispatch(task.state, { taskId: task.value.id, provider: 'claude', accountId: 'acc1', sessionId: 'ses_host', cwd: 'D:/p', specPath: 'D:/p/s.md' }, NOW)
    if (!dsp.ok) throw new Error(dsp.error)
    return { state: dsp.state, dispatchId: dsp.value.id }
  }
  const appDeps = (state: OrchState, kill: KillWorkerDeps): OrchServerDeps & { box: { state: OrchState } } => {
    const box = { state }
    const coordinator = new OrchCoordinator({
      specsDir: 'D:/specs',
      spawnSession: async () => ({ id: 'never' }),
      writeToSession: () => {},
      isBusy: () => null,
      isAlive: () => false,
      killSession: (id) => killWorkerSession(id, kill),
      createWorktree: async () => ({ path: 'D:/wt' }),
      accountProvider: () => 'claude',
      log: () => {}
    })
    return {
      box,
      getState: () => box.state,
      setState: async (next) => {
        box.state = next
      },
      startWorker: async () => ({ sessionId: 'x', cwd: 'D:/p', specPath: 'D:/p/x.md' }),
      releaseWorker: async ({ dispatchId }) => {
        const args = releaseArgsFor(box.state.dispatches, dispatchId)
        if (args) await coordinator.releaseWorker(args)
      },
      listAccounts: () => [],
      readWorker: async () => '',
      now: () => NOW
    } as OrchServerDeps & { box: { state: OrchState } }
  }

  it('before adoption, ends the worker in the Host and only then marks the Dispatch stopped', async () => {
    const { state, dispatchId } = withWorker()
    const h = rig({})
    const deps = appDeps(state, h.d)
    const r = await handleCommand(deps, { sessionId: 'astera:app' }, 'worker-stop', { dispatch: dispatchId })
    expect(r.status).toBe(200)
    expect(h.hostKilled).toEqual(['p_host'])
    expect(deps.box.state.dispatches[0].workerState).toBe('stopped')
  })
  it('before adoption, with a Host that does not answer, fails and leaves the Dispatch open', async () => {
    const { state, dispatchId } = withWorker()
    const h = rig({ entries: [null] })
    const deps = appDeps(state, h.d)
    await expect(handleCommand(deps, { sessionId: 'astera:app' }, 'worker-stop', { dispatch: dispatchId })).rejects.toThrow(/not stopped/)
    expect(deps.box.state.dispatches[0].endedAt).toBeUndefined()
    expect(deps.box.state.dispatches[0].workerState).not.toBe('stopped')
  })
  it('before adoption, with a kill the Host never carried out, fails and leaves the Dispatch open', async () => {
    const { state, dispatchId } = withWorker()
    const h = rig({ exit: 'silent' })
    const deps = appDeps(state, h.d)
    await expect(handleCommand(deps, { sessionId: 'astera:app' }, 'worker-stop', { dispatch: dispatchId })).rejects.toThrow(/not stopped/)
    expect(deps.box.state.dispatches[0].endedAt).toBeUndefined()
  })
  it('after adoption, kills through the app handle', async () => {
    const { state, dispatchId } = withWorker()
    const h = rig({ app: { status: 'running' } })
    const deps = appDeps(state, h.d)
    const r = await handleCommand(deps, { sessionId: 'astera:app' }, 'worker-stop', { dispatch: dispatchId })
    expect(r.status).toBe(200)
    expect(h.appKilled).toEqual(['ses_host'])
    expect(h.hostKilled).toEqual([])
  })
})
