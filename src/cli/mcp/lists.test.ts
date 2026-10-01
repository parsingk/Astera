import { describe, it, expect } from 'vitest'
import { LIST_LIMIT, orderAndCut } from './lists'

const rows = (n: number, at = (i: number) => `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z`) =>
  Array.from({ length: n }, (_, i) => ({ id: `x${i}`, createdAt: at(i), ordinal: i + 1 }))

describe('orderAndCut', () => {
  it('list_jobs is newest first by createdAt', () => {
    const { list } = orderAndCut('list_jobs', rows(3), 50)
    expect(list.map((r) => (r as { id: string }).id)).toEqual(['x2', 'x1', 'x0'])
  })

  // `ordinal` counts per Job, so across Jobs it is not time: a young Job's newest Run has ordinal 1.
  it('list_runs is newest first by createdAt, across Jobs, before the cut', () => {
    const runs = [
      { id: 'old1', jobId: 'j1', ordinal: 1, createdAt: '2026-10-01T00:00:01.000Z' },
      { id: 'old2', jobId: 'j1', ordinal: 2, createdAt: '2026-10-01T00:00:02.000Z' },
      { id: 'old3', jobId: 'j1', ordinal: 3, createdAt: '2026-10-01T00:00:03.000Z' },
      { id: 'late', jobId: 'j2', ordinal: 1, createdAt: '2026-10-01T00:00:09.000Z' }
    ]
    const { list } = orderAndCut('list_runs', runs, 2)
    expect(list.map((r) => (r as { id: string }).id)).toEqual(['late', 'old3'])
  })

  it('list_runs breaks a createdAt tie by ordinal, highest first', () => {
    const at = '2026-10-01T00:00:00.000Z'
    const { list } = orderAndCut('list_runs', [{ id: 'a', ordinal: 1, createdAt: at }, { id: 'b', ordinal: 2, createdAt: at }], 50)
    expect(list.map((r) => (r as { id: string }).id)).toEqual(['b', 'a'])
  })

  it('list_questions is oldest first by createdAt', () => {
    const { list } = orderAndCut('list_questions', rows(3).reverse(), 50)
    expect(list.map((r) => (r as { id: string }).id)).toEqual(['x0', 'x1', 'x2'])
  })

  it('list_tasks, list_projects and list_accounts keep the Host order', () => {
    const given = rows(3).reverse()
    for (const tool of ['list_tasks', 'list_projects', 'list_accounts'])
      expect(orderAndCut(tool, given, 50).list, tool).toEqual(given)
  })

  it('cuts to the limit after ordering and says so with the total', () => {
    const cut = orderAndCut('list_jobs', rows(5), 2)
    expect(cut.list.map((r) => (r as { id: string }).id)).toEqual(['x4', 'x3'])
    expect(cut).toMatchObject({ truncated: true, total: 5 })
  })

  it('a list within the limit carries neither truncated nor total', () => {
    const whole = orderAndCut('list_jobs', rows(2), 2)
    expect(whole.list).toHaveLength(2)
    expect('truncated' in whole).toBe(false)
    expect('total' in whole).toBe(false)
  })

  it('leaves the given list as it was', () => {
    const given = rows(3)
    orderAndCut('list_jobs', given, 1)
    expect(given.map((r) => r.id)).toEqual(['x0', 'x1', 'x2'])
  })

  it('limits run 1 to 200 and default to 50', () => {
    expect(LIST_LIMIT).toEqual({ min: 1, max: 200, default: 50 })
  })
})
