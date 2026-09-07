import { describe, it, expect } from 'vitest'
import { pickRunSelection, pickRunToShow } from './selection'

const cfgs = (...ids: string[]): { id: string }[] => ids.map((id) => ({ id }))

describe('pickRunSelection', () => {
  it('keeps the preferred config when it is still in the list', () => {
    expect(pickRunSelection(cfgs('seed:npm:dev', 'seed:npm:start'), 'seed:npm:start')).toBe(
      'seed:npm:start'
    )
  })

  // The bug this function exists for. Seed ids are derived from the script name
  // (`seed:npm:<script>`) and carry no project, so project A's `seed:npm:dev` is a perfectly valid id
  // in project B whenever B also has a dev script — which for npm projects is the ordinary case. The
  // old code kept the previous selection whenever the id still resolved, so switching A → B silently
  // handed B the choice made in A. Passing the preference *for this project* is what makes the
  // collision harmless: B is asked about B's own remembered id, never about A's.
  it('a foreign id is not preferred just because it happens to resolve here', () => {
    // B's own memory says 'start'; A's id collides with a real entry in B and must not win
    expect(pickRunSelection(cfgs('seed:npm:dev', 'seed:npm:start'), 'seed:npm:start')).toBe(
      'seed:npm:start'
    )
    // With no memory for this project at all, the active run decides — not whatever was on screen
    expect(
      pickRunSelection(cfgs('seed:npm:dev', 'seed:npm:start'), undefined, 'seed:npm:start')
    ).toBe('seed:npm:start')
  })

  it('falls back to the running config when the preference does not resolve', () => {
    expect(pickRunSelection(cfgs('a', 'b'), 'gone', 'b')).toBe('b')
    expect(pickRunSelection(cfgs('a', 'b'), null, 'b')).toBe('b')
  })

  // Promoting a seed removes an id: mergeConfigs stops emitting seed:npm:dev the moment a stored
  // config shares its seedKeyOf. A selection left pointing at the vanished id keeps ▶ enabled — the
  // guard is `disabled={!selectedId}` and a stale string is truthy — and pressing it fails with
  // NO_CONFIG.
  it('falls back to the first config when neither the preference nor the active id resolves', () => {
    expect(pickRunSelection(cfgs('a', 'b'), 'gone', 'also-gone')).toBe('a')
    expect(pickRunSelection(cfgs('a', 'b'), undefined)).toBe('a')
  })

  it('is null when the project has no configs at all', () => {
    expect(pickRunSelection([], 'anything', 'anything')).toBeNull()
    expect(pickRunSelection([], undefined)).toBeNull()
  })

  // The two callers that reconcile after a delete or a save deliberately do not consider the running
  // config, so the argument is optional and its absence must not be read as "no active run, fall all
  // the way through" in a way that differs from passing null.
  it('an omitted active id behaves exactly like a null one', () => {
    expect(pickRunSelection(cfgs('a', 'b'), 'gone')).toBe(pickRunSelection(cfgs('a', 'b'), 'gone', null))
  })
})

describe('pickRunToShow', () => {
  const r = (runId: string, status: string) => ({ runId, status })
  it('prefers a live run over an earlier finished one', () => {
    expect(pickRunToShow([r('a', 'exited'), r('b', 'stopping'), r('c', 'running')])).toBe('b')
  })
  it('falls back to the first row when nothing is live', () => {
    expect(pickRunToShow([r('a', 'exited'), r('b', 'exited')])).toBe('a')
  })
  it('is null with no runs', () => {
    expect(pickRunToShow([])).toBeNull()
  })
})
