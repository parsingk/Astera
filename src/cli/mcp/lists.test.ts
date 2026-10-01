import { describe, it, expect } from 'vitest'
import { LIST_LIMIT, cursorOffset, orderAndCut, pageCursor } from './lists'

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

// Spec §48: a cut list says where the next page starts, with an opaque cursor for that tool alone.
describe('cursor paging', () => {
  const ids = (cut: { list: unknown[] }): string[] => cut.list.map((r) => (r as { id: string }).id)

  it('a cut list carries nextCursor, and the cursor gives the next page in the same order', () => {
    const all = rows(5)
    const first = orderAndCut('list_jobs', all, 2)
    expect(ids(first)).toEqual(['x4', 'x3'])
    expect(first).toMatchObject({ truncated: true, total: 5 })
    expect(typeof first.nextCursor).toBe('string')
    const second = orderAndCut('list_jobs', all, 2, cursorOffset('list_jobs', first.nextCursor!) as number)
    expect(ids(second)).toEqual(['x2', 'x1'])
    expect(second).toMatchObject({ truncated: true, total: 5 })
    const third = orderAndCut('list_jobs', all, 2, cursorOffset('list_jobs', second.nextCursor!) as number)
    expect(ids(third)).toEqual(['x0'])
    // The last page: still not the whole list, so truncated and total stay; nothing more remains.
    expect(third).toMatchObject({ truncated: true, total: 5 })
    expect('nextCursor' in third).toBe(false)
  })

  it('a whole list carries no nextCursor', () => {
    expect('nextCursor' in orderAndCut('list_jobs', rows(2), 2)).toBe(false)
  })

  it('an offset past the end is an empty page that still says the total', () => {
    const cut = orderAndCut('list_jobs', rows(2), 2, 5)
    expect(cut.list).toEqual([])
    expect(cut).toMatchObject({ truncated: true, total: 2 })
    expect('nextCursor' in cut).toBe(false)
  })

  it('the cursor is base64url JSON of the offset and the tool', () => {
    const c = pageCursor('list_runs', 50)
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(JSON.parse(Buffer.from(c, 'base64url').toString('utf8'))).toEqual({ o: 50, k: 'list_runs' })
    expect(cursorOffset('list_runs', c)).toBe(50)
  })

  it("refuses another tool's cursor and a malformed one with a message that says so", () => {
    const enc = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')
    expect(cursorOffset('list_jobs', pageCursor('list_runs', 2))).toEqual({ error: expect.stringContaining('list_runs') })
    for (const bad of ['%%%', 'bm90IGpzb24', enc([1]), enc({ o: -1, k: 'list_jobs' }), enc({ o: 1.5, k: 'list_jobs' }), enc({ o: '2', k: 'list_jobs' }), enc({ k: 'list_jobs' })])
      expect(cursorOffset('list_jobs', bad), bad).toEqual({ error: expect.stringContaining('cursor') })
  })

  // Review fix round 1, Minor 5: a tool name with an underscore after list_ is still named back.
  it("names list_run_configs when its cursor is given to another tool", () => {
    expect(cursorOffset('list_jobs', pageCursor('list_run_configs', 2))).toEqual({
      error: expect.stringContaining('cursor is from list_run_configs, not list_jobs')
    })
    expect(cursorOffset('list_run_configs', pageCursor('list_run_configs', 2))).toBe(2)
  })
})
