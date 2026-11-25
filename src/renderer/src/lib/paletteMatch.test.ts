import { describe, it, expect } from 'vitest'
import type { ActionId } from '../../../core/keys/binding'
import { rankActions } from './paletteMatch'

const rows: { id: ActionId; title: string }[] = [
  { id: 'explorer.toggleMode', title: 'Toggle the explorer' },
  { id: 'sidebar.jobs', title: 'Toggle the Jobs sidebar' },
  { id: 'run.run', title: 'Run' },
  { id: 'run.rerun', title: 'Rerun the selected run' },
  { id: 'job.new', title: 'New Job' },
  { id: 'kube.open', title: 'Kubernetes 패널 열기/닫기' }
]
const ids = (r: { id: ActionId }[]): ActionId[] => r.map((x) => x.id)

describe('rankActions', () => {
  it('puts a title that starts with the query first, then a word that starts with it, then any match', () => {
    expect(ids(rankActions(rows, 'run', []))).toEqual(['run.run', 'run.rerun'])
    expect(ids(rankActions(rows, 'jo', []))).toEqual(['sidebar.jobs', 'job.new'])
    expect(ids(rankActions(rows, 'ob', []))).toEqual(['sidebar.jobs', 'job.new'])
  })

  it('ignores case and surrounding spaces', () => {
    expect(ids(rankActions(rows, '  NEW ', []))).toEqual(['job.new'])
  })

  it('matches words split by a slash, as Korean titles use', () => {
    expect(ids(rankActions(rows, '닫기', []))).toEqual(['kube.open'])
  })

  it('falls back to the action id, so an English id finds a translated title', () => {
    expect(ids(rankActions(rows, 'togglemode', []))).toEqual(['explorer.toggleMode'])
  })

  it('shows recent actions first within a tier, most recent first, and the rest in list order', () => {
    expect(ids(rankActions(rows, 'toggle', ['sidebar.jobs']))).toEqual(['sidebar.jobs', 'explorer.toggleMode'])
    // A recent action never jumps a better match: the first row is still the title that starts with the query.
    expect(ids(rankActions(rows, 'run', ['run.rerun']))).toEqual(['run.run', 'run.rerun'])
    expect(ids(rankActions(rows, '', ['job.new', 'run.run']))).toEqual([
      'job.new',
      'run.run',
      'explorer.toggleMode',
      'sidebar.jobs',
      'run.rerun',
      'kube.open'
    ])
  })

  it('returns nothing for a query nothing contains', () => {
    expect(rankActions(rows, 'zzz', [])).toEqual([])
  })

  // A plugin's command (Phase 2 step 3) is ranked by its title like any action, and by its key as the id tier
  it('ranks a plugin command by its title, then by its contribution key', () => {
    const mixed = [...rows, { id: 'hello-panel:open', title: 'Open Hello panel' }]
    expect(rankActions(mixed, 'hello', []).map((r) => r.id)).toEqual(['hello-panel:open'])
    expect(rankActions(mixed, 'panel:op', []).map((r) => r.id)).toEqual(['hello-panel:open'])
    expect(rankActions(mixed, 'open', ['hello-panel:open'])[0].id).toBe('hello-panel:open')
  })
})
