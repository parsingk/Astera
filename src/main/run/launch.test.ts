import { describe, it, expect } from 'vitest'
import type { RunStatus } from '../../core/run/config'
import type { LaunchPlan } from '../../core/run/launch'
import { executeLaunch, type LaunchDeps } from './launch'

type Ok = Extract<LaunchPlan, { ok: true }>
const plan = (steps: [string, string[]][], focusId = steps[0][0]): Ok => ({
  ok: true,
  steps: steps.map(([configId, after]) => ({ configId, after })),
  focusId
})

const statusOf = (configId: string): RunStatus => ({
  runId: `run:${configId}`,
  projectPath: '/p',
  projectName: 'p',
  configId,
  configName: configId,
  command: 'x',
  seq: 1,
  status: 'running',
  startedAt: 1
})

/** A controllable stand-in for the two RunManager calls the executor makes. Each configuration's exit
 *  is held open until the test releases it, so ordering can be observed rather than raced. */
function deps(opts: { fail?: Record<string, number>; reject?: string[] } = {}) {
  const started: string[] = []
  const focused: string[] = []
  const failures: { configId: string; detail: string }[] = []
  const gates = new Map<string, (code: number | null) => void>()
  const d: LaunchDeps = {
    startOne: async (configId) => {
      if (opts.reject?.includes(configId)) throw new Error(`spawn refused: ${configId}`)
      started.push(configId)
      return statusOf(configId)
    },
    whenExited: (runId) =>
      new Promise((resolve) => gates.set(runId.replace(/^run:/, ''), resolve)),
    onFocus: (status) => focused.push(status.runId),
    onFailed: (configId, detail) => failures.push({ configId, detail })
  }
  /** Drains the microtask queue so the executor's promise chains have all run. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
  }
  /** Lets a started configuration finish, waiting for the executor to have registered its gate. */
  const finish = async (configId: string, code: number | null = 0): Promise<void> => {
    for (let i = 0; i < 40 && !gates.has(configId); i += 1) await Promise.resolve()
    gates.get(configId)?.(code)
    await settle()
  }
  return { d, started, focused, failures, finish, settle }
}

describe('executeLaunch', () => {
  it('resolves with the first step so the panel can open at once', async () => {
    const { d } = deps()
    const first = await executeLaunch(plan([['a', []]]), d)
    expect(first.configId).toBe('a')
  })

  it('does not start the main step until its task exits 0', async () => {
    const { d, started, finish } = deps()
    await executeLaunch(plan([['build', []], ['dev', ['build']]], 'dev'), d)
    expect(started).toEqual(['build'])
    await finish('build', 0)
    expect(started).toEqual(['build', 'dev'])
  })

  it('never starts the main step when its task fails', async () => {
    const { d, started, finish } = deps()
    await executeLaunch(plan([['build', []], ['dev', ['build']]], 'dev'), d)
    await finish('build', 1)
    expect(started).toEqual(['build'])
  })

  // whenExited settles null for a runId RunManager does not hold — not for a killed run, which still
  // reports its (non-zero) exit code. The executor cannot tell that case apart from any other reason
  // a chain should stop, so it treats null as a failed task, the same as a non-zero code.
  it('treats a run that ended without a code as failed', async () => {
    const { d, started, finish } = deps()
    await executeLaunch(plan([['build', []], ['dev', ['build']]], 'dev'), d)
    await finish('build', null)
    expect(started).toEqual(['build'])
  })

  it('skipping propagates down the chain', async () => {
    const { d, started, finish } = deps()
    await executeLaunch(plan([['a', []], ['b', ['a']], ['c', ['b']]], 'c'), d)
    await finish('a', 1)
    expect(started).toEqual(['a'])
  })

  it('starts independent steps together', async () => {
    const { d, started, settle } = deps()
    await executeLaunch(plan([['api', []], ['web', []]], 'api'), d)
    // Both start without either having exited — that is what "together" means here
    await settle()
    expect(started.sort()).toEqual(['api', 'web'])
  })

  it('starts a configuration once when two steps wait on it', async () => {
    const { d, started, finish } = deps()
    await executeLaunch(plan([['build', []], ['api', ['build']], ['web', ['build']]], 'api'), d)
    await finish('build', 0)
    expect(started).toEqual(['build', 'api', 'web'])
    expect(started.filter((x) => x === 'build')).toHaveLength(1)
  })

  it('focuses the run of the configuration whose play button was pressed', async () => {
    const { d, focused, finish } = deps()
    await executeLaunch(plan([['build', []], ['dev', ['build']]], 'dev'), d)
    expect(focused).toEqual([])
    await finish('build', 0)
    expect(focused).toEqual(['run:dev'])
  })

  // Rare, because prepareLaunch has already assembled every step. Without this the failure is a tab
  // that silently never appears, and every step behind it waits forever.
  it('reports a step that refuses to start and does not hang the chain', async () => {
    const { d, started, failures, finish } = deps({ reject: ['dev'] })
    await executeLaunch(plan([['build', []], ['dev', ['build']], ['after', ['dev']]], 'dev'), d)
    await finish('build', 0)
    expect(failures).toHaveLength(1)
    expect(failures[0].configId).toBe('dev')
    expect(started).toEqual(['build'])
  })

  // The first step is different: run.start has not resolved yet, so its rejection IS the answer the
  // renderer gets, and the existing toast reports it. Reporting an event as well would say it twice —
  // and swallowing it would leave the caller with nothing to open the panel on.
  it('rejects rather than reporting an event when the very first step refuses to start', async () => {
    const { d, failures } = deps({ reject: ['a'] })
    await expect(executeLaunch(plan([['a', []]]), d)).rejects.toThrow('spawn refused: a')
    expect(failures).toEqual([])
  })

  it('a later step still runs when an unrelated first step fails to start', async () => {
    const { d, started, settle } = deps({ reject: ['api'] })
    await expect(executeLaunch(plan([['api', []], ['web', []]], 'api'), d)).rejects.toThrow()
    await settle()
    expect(started).toEqual(['web'])
  })
})
