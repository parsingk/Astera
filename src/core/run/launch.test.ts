import { describe, it, expect } from 'vitest'
import type { RunConfig } from './types'
import { planLaunch, addableTargets } from './launch'

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
})

describe('addableTargets', () => {
  const list = [sh('a'), sh('b'), sh('c')]

  it('offers the others', () => {
    expect(addableTargets(list, 'a', []).map((c) => c.id)).toEqual(['b', 'c'])
  })

  it('never offers the host itself', () => {
    expect(addableTargets(list, 'a', []).map((c) => c.id)).not.toContain('a')
  })

  it('never offers one already in the list', () => {
    expect(addableTargets(list, 'a', ['b']).map((c) => c.id)).toEqual(['c'])
  })

  it('never offers one that would close a cycle', () => {
    const cyclic = [sh('a'), sh('b', { beforeLaunch: ['a'] })]
    expect(addableTargets(cyclic, 'a', []).map((c) => c.id)).toEqual([])
  })
})
