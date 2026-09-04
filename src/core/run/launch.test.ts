import { describe, it, expect } from 'vitest'
import type { RunConfig } from './types'
import { planLaunch, addableTargets, referencedIds } from './launch'

const sh = (id: string, extra: Partial<RunConfig> = {}): RunConfig =>
  ({ id, name: id, type: 'shell', command: `echo ${id}`, ...extra }) as RunConfig
const comp = (id: string, members: string[], extra: Partial<RunConfig> = {}): RunConfig =>
  ({ id, name: id, type: 'compound', members, ...extra }) as RunConfig

/** The plan as a readable pair — the assertions below care about order and dependencies, not shape */
const shape = (p: ReturnType<typeof planLaunch>): [string, string[]][] => {
  if (!p.ok) throw new Error(`plan failed: ${p.reason}`)
  return p.steps.map((s) => [s.configId, s.after])
}

describe('planLaunch', () => {
  it('a configuration with no chain is one step that waits on nothing', () => {
    const p = planLaunch([sh('a')], 'a')
    expect(shape(p)).toEqual([['a', []]])
    expect(p.ok && p.focusId).toBe('a')
  })

  it('one before-launch task runs first', () => {
    const p = planLaunch([sh('build'), sh('dev', { beforeLaunch: ['build'] })], 'dev')
    expect(shape(p)).toEqual([['build', []], ['dev', ['build']]])
    expect(p.ok && p.focusId).toBe('dev')
  })

  // Order matters: before-launch tasks are sequential, so the second waits on the first.
  it('several tasks run in the order they are listed', () => {
    const p = planLaunch([sh('x'), sh('y'), sh('m', { beforeLaunch: ['x', 'y'] })], 'm')
    expect(shape(p)).toEqual([['x', []], ['y', ['x']], ['m', ['x', 'y']]])
  })

  it('a compound has no step of its own and its members wait on nothing', () => {
    const p = planLaunch([sh('api'), sh('web'), comp('all', ['api', 'web'])], 'all')
    expect(shape(p)).toEqual([['api', []], ['web', []]])
    expect(p.ok && p.focusId).toBe('api')
  })

  it("a compound's own before-launch task gates every member", () => {
    const p = planLaunch(
      [sh('install'), sh('api'), sh('web'), comp('all', ['api', 'web'], { beforeLaunch: ['install'] })],
      'all'
    )
    expect(shape(p)).toEqual([['install', []], ['api', ['install']], ['web', ['install']]])
  })

  it('a member carries its own before-launch task', () => {
    const p = planLaunch([sh('build'), sh('api', { beforeLaunch: ['build'] }), sh('web'), comp('all', ['api', 'web'])], 'all')
    expect(shape(p)).toEqual([['build', []], ['api', ['build']], ['web', []]])
  })

  // "This compound has finished" means every member has finished, so the main step waits on all of them.
  it('a before-launch task that is a compound is waited on member by member', () => {
    const p = planLaunch([sh('api'), sh('web'), comp('back', ['api', 'web']), sh('e2e', { beforeLaunch: ['back'] })], 'e2e')
    expect(shape(p)).toEqual([['api', []], ['web', []], ['e2e', ['api', 'web']]])
  })

  // The diamond. Without the union, two identical builds would run at once against the same output
  // directory — and the second would restart the first, leaving one member waiting on a killed run.
  it('a task named by two members runs once and both wait on it', () => {
    const p = planLaunch(
      [sh('build'), sh('api', { beforeLaunch: ['build'] }), sh('web', { beforeLaunch: ['build'] }), comp('all', ['api', 'web'])],
      'all'
    )
    expect(shape(p)).toEqual([['build', []], ['api', ['build']], ['web', ['build']]])
  })

  it('refuses a direct cycle and names the path', () => {
    const p = planLaunch([sh('a', { beforeLaunch: ['b'] }), sh('b', { beforeLaunch: ['a'] })], 'a')
    expect(p).toMatchObject({ ok: false, reason: 'CYCLE' })
    expect(p.ok === false && p.reason === 'CYCLE' && p.path).toContain('a')
  })

  it('refuses a configuration that names itself', () => {
    const p = planLaunch([sh('a', { beforeLaunch: ['a'] })], 'a')
    expect(p).toMatchObject({ ok: false, reason: 'CYCLE' })
  })

  // The configuration graph here has no cycle: no configuration reaches itself by following
  // beforeLaunch and members. The cycle appears only once the two steps' `after` lists are unioned —
  // x waits on y through c1, y waits on x through c2. Undetected, the executor's promises deadlock.
  it('refuses a cycle that only the merged dependencies create', () => {
    const p = planLaunch(
      [
        sh('x'),
        sh('y'),
        comp('c1', ['x'], { beforeLaunch: ['y'] }),
        comp('c2', ['y'], { beforeLaunch: ['x'] }),
        comp('root', ['c1', 'c2'])
      ],
      'root'
    )
    expect(p).toMatchObject({ ok: false, reason: 'CYCLE' })
  })

  it('names the holder of a reference that resolves to nothing', () => {
    const p = planLaunch([sh('dev', { beforeLaunch: ['gone'] })], 'dev')
    expect(p).toEqual({ ok: false, reason: 'MISSING', id: 'gone', heldBy: 'dev' })
  })

  it('reports a missing root with no holder', () => {
    const p = planLaunch([sh('a')], 'nope')
    expect(p).toEqual({ ok: false, reason: 'MISSING', id: 'nope', heldBy: null })
  })

  it('names the holder of a missing reference inside a compound member list', () => {
    const p = planLaunch([sh('api'), comp('all', ['api', 'gone'])], 'all')
    expect(p).toEqual({ ok: false, reason: 'MISSING', id: 'gone', heldBy: 'all' })
  })

  it('refuses a compound that names itself as its own member', () => {
    const p = planLaunch([comp('a', ['a'])], 'a')
    expect(p).toMatchObject({ ok: false, reason: 'CYCLE' })
  })

  it('focusId reaches through two levels of nested compounds to the first real run', () => {
    const p = planLaunch([sh('api'), sh('web'), comp('back', ['api']), comp('all', ['back', 'web'])], 'all')
    expect(p.ok && p.focusId).toBe('api')
  })

  it('an empty compound as the root has no steps and its own id as the focus', () => {
    const p = planLaunch([comp('empty', [])], 'empty')
    expect(shape(p)).toEqual([])
    expect(p.ok && p.focusId).toBe('empty')
  })

  // A duplicate id in a hand-edited beforeLaunch list is not reachable through the ＋ dialog
  // (addableTargets filters it out), but migrateRunConfigs accepts one, and this is the last
  // check before the executor. Without dedupe, the second 'x' inherits the first's own id back
  // as its dependency and topoSort reports a self-loop that the configuration graph doesn't have.
  it('a duplicate id in one beforeLaunch list plans two steps, not a cycle', () => {
    const p = planLaunch([sh('x'), sh('m', { beforeLaunch: ['x', 'x'] })], 'm')
    expect(shape(p)).toEqual([['x', []], ['m', ['x']]])
  })

  // The merge-only cycle from above, plus an unrelated before-launch task on the same root. 'w'
  // never depends on anything and nothing depends on it, so it resolves in the first topoSort
  // round and must not be swept into the reported path once x and y deadlock in the next one.
  it('names only the steps that loop, not an unrelated before-launch task caught in the same plan', () => {
    const p = planLaunch(
      [
        sh('x'),
        sh('y'),
        comp('c1', ['x'], { beforeLaunch: ['y'] }),
        comp('c2', ['y'], { beforeLaunch: ['x'] }),
        sh('w'),
        comp('root', ['c1', 'c2'], { beforeLaunch: ['w'] })
      ],
      'root'
    )
    expect(p).toMatchObject({ ok: false, reason: 'CYCLE' })
    expect(p.ok === false && p.reason === 'CYCLE' && p.path).not.toContain('w')
  })
})

describe('addableTargets', () => {
  const list = [sh('a'), sh('b'), sh('c')]

  it('offers the others', () => {
    expect(addableTargets(list, 'a', 'beforeLaunch', []).map((c) => c.id)).toEqual(['b', 'c'])
  })

  it('never offers the host itself', () => {
    expect(addableTargets(list, 'a', 'beforeLaunch', []).map((c) => c.id)).not.toContain('a')
  })

  it('never offers one already in the list', () => {
    expect(addableTargets(list, 'a', 'beforeLaunch', ['b']).map((c) => c.id)).toEqual(['c'])
  })

  it('never offers one that would close a cycle', () => {
    const cyclic = [sh('a'), sh('b', { beforeLaunch: ['a'] })]
    expect(addableTargets(cyclic, 'a', 'beforeLaunch', []).map((c) => c.id)).toEqual([])
  })

  // host's own stored members is empty -- 'c1' exists only in the draft list passed as `current`.
  // A probe built from the stored field instead would miss that c1 is already there and wrongly
  // offer c2, even though the two together (exactly the merge-only-cycle fixture) close a cycle.
  it('probes the draft list, not the stored one, so a reference only in the draft can still close a cycle', () => {
    const configs = [
      sh('x'),
      sh('y'),
      comp('c1', ['x'], { beforeLaunch: ['y'] }),
      comp('c2', ['y'], { beforeLaunch: ['x'] }),
      comp('host', [])
    ]
    expect(addableTargets(configs, 'host', 'members', ['c1']).map((c) => c.id)).not.toContain('c2')
  })

  // withRef used to guess which field to probe from the host's type, so a compound host always got
  // its candidate written into `members` — even when the caller (the Before launch picker) meant
  // `beforeLaunch`. That silently threw away the compound's real members for the probe, so a cycle
  // that only exists once those real members are considered went undetected.
  it("refuses a beforeLaunch candidate that closes a cycle only once the compound's real members are considered", () => {
    const worker = sh('worker')
    const candidate = sh('candidate', { beforeLaunch: ['worker'] })
    const host = comp('host', ['worker'])
    const configs = [worker, candidate, host]
    expect(addableTargets(configs, 'host', 'beforeLaunch', []).map((c) => c.id)).not.toContain('candidate')
  })

  // The mirror bug: writing into the wrong field can also manufacture a cycle that isn't really
  // there, withholding a candidate that is perfectly safe once probed against the field actually
  // being edited.
  it('offers a beforeLaunch candidate the old field-guessing code would have wrongly refused', () => {
    const taskA = sh('taskA')
    const real1 = sh('real1')
    const candidate = sh('candidate')
    const host = comp('host', ['real1'], { beforeLaunch: ['taskA'] })
    const configs = [taskA, real1, candidate, host]
    expect(addableTargets(configs, 'host', 'beforeLaunch', ['taskA']).map((c) => c.id)).toContain('candidate')
  })
})

describe('referencedIds', () => {
  it('a plain configuration with no references names none', () => {
    expect(referencedIds(sh('a'))).toEqual([])
  })

  it('a configuration with before-launch tasks names them', () => {
    expect(referencedIds(sh('a', { beforeLaunch: ['b', 'c'] }))).toEqual(['b', 'c'])
  })

  it("a compound's members are references", () => {
    expect(referencedIds(comp('all', ['api', 'web']))).toEqual(['api', 'web'])
  })

  it('a compound with both before-launch tasks and members names both, before-launch first', () => {
    expect(referencedIds(comp('all', ['api', 'web'], { beforeLaunch: ['install'] }))).toEqual([
      'install',
      'api',
      'web'
    ])
  })

  // Pins this function's answer against planLaunch's own reference model (expand, above), so the two
  // definitions cannot quietly drift apart: every id referencedIds reports for a host must actually
  // show up as a step planLaunch produces for it.
  it('every id referencedIds reports for a host is a step planLaunch actually produces', () => {
    const install = sh('install')
    const api = sh('api')
    const web = sh('web')
    const host = comp('all', ['api', 'web'], { beforeLaunch: ['install'] })
    const p = planLaunch([install, api, web, host], 'all')
    const stepIds = p.ok ? p.steps.map((s) => s.configId) : []
    for (const id of referencedIds(host)) expect(stepIds).toContain(id)
  })
})
