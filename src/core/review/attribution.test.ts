import { describe, it, expect } from 'vitest'
import type { Dispatch } from '../orchestration/types'
import { attributeFiles, type AttemptChanges } from './attribution'

// Phase 3 Part 4: which agent attempt changed each file, from recorded ranges only (never git author or mtime)
const NOW = '2026-11-27T12:00:00.000Z'
const dispatch = (over: Partial<Dispatch> & { id: string }): Dispatch => ({
  taskId: 't1',
  provider: 'claude',
  accountId: 'claude-a',
  sessionId: `s-${over.id}`,
  cwd: 'F:\\proj-wt',
  specPath: '',
  startedAt: '2026-11-27T10:00:00.000Z',
  endedAt: '2026-11-27T10:10:00.000Z',
  workerState: 'stopped',
  retained: false,
  git: { base: 'aaaaaaa', head: 'bbbbbbb' },
  ...over
})
const attempt = (d: Dispatch, files: string[] | null, over: Partial<AttemptChanges> = {}): AttemptChanges => ({ dispatch: d, files, fastForward: true, shared: false, ...over })

describe('attributeFiles', () => {
  it('credits a file to the one attempt whose range changed it, on its recorded range', () => {
    const d1 = dispatch({ id: 'd1', nativeSessionId: 'n1' })
    const got = attributeFiles(['src/a.ts'], [attempt(d1, ['src/a.ts'])], [], NOW, 'win32')
    expect(got['src/a.ts']).toEqual({
      kind: 'agent',
      level: 'recorded-range',
      evidence: [{ dispatchId: 'd1', taskId: 't1', provider: 'claude', accountId: 'claude-a', sessionId: 's-d1', nativeSessionId: 'n1', cwd: 'F:\\proj-wt', base: 'aaaaaaa', head: 'bbbbbbb' }]
    })
  })

  it('credits a file changed by an attempt and then by its repair in the same folder to both', () => {
    const d1 = dispatch({ id: 'd1' })
    const d2 = dispatch({ id: 'd2', provider: 'codex', startedAt: '2026-11-27T10:20:00.000Z', endedAt: '2026-11-27T10:30:00.000Z', git: { base: 'bbbbbbb', head: 'ccccccc' }, repair: 'review-failure' })
    const got = attributeFiles(['src/a.ts', 'src/b.ts'], [attempt(d2, ['src/a.ts']), attempt(d1, ['src/a.ts', 'src/b.ts'])], [], NOW, 'win32')
    expect(got['src/a.ts'].kind).toBe('agent')
    expect(got['src/a.ts'].evidence.map((e) => e.dispatchId)).toEqual(['d1', 'd2'])
    expect(got['src/b.ts'].evidence.map((e) => e.dispatchId)).toEqual(['d1'])
  })

  it('calls mixed a file of an attempt whose window overlaps another Dispatch in the same folder, from any Run', () => {
    const d1 = dispatch({ id: 'd1', cwd: 'F:\\Proj' })
    const other = dispatch({ id: 'x9', taskId: 'other-task', cwd: 'f:\\proj', startedAt: '2026-11-27T10:05:00.000Z', endedAt: '2026-11-27T10:15:00.000Z' })
    const got = attributeFiles(['src/a.ts'], [attempt(d1, ['src/a.ts'], { shared: true })], [other], NOW, 'win32')
    expect(got['src/a.ts']).toMatchObject({ kind: 'mixed', why: 'overlap' })
    expect(got['src/a.ts'].evidence.map((e) => e.dispatchId)).toEqual(['d1'])
  })

  it('counts a Dispatch still open as running until now when it overlaps', () => {
    const d1 = dispatch({ id: 'd1', startedAt: '2026-11-27T11:00:00.000Z', endedAt: '2026-11-27T11:30:00.000Z' })
    const open = dispatch({ id: 'x9', taskId: 'other-task', startedAt: '2026-11-27T10:00:00.000Z', endedAt: undefined })
    expect(attributeFiles(['src/a.ts'], [attempt(d1, ['src/a.ts'])], [open], NOW, 'win32')['src/a.ts'].kind).toBe('mixed')
  })

  it('does not call mixed two attempts that overlap in different folders, nor two that only touch end to start', () => {
    const d1 = dispatch({ id: 'd1' })
    const elsewhere = dispatch({ id: 'x8', taskId: 'other-task', cwd: 'F:\\other', startedAt: '2026-11-27T10:05:00.000Z' })
    const after = dispatch({ id: 'x9', taskId: 'other-task', startedAt: '2026-11-27T10:10:00.000Z', endedAt: '2026-11-27T10:20:00.000Z' })
    expect(attributeFiles(['src/a.ts'], [attempt(d1, ['src/a.ts'])], [elsewhere, after], NOW, 'win32')['src/a.ts'].kind).toBe('agent')
  })

  it('says unknown for a range that is not a fast-forward', () => {
    const d1 = dispatch({ id: 'd1' })
    expect(attributeFiles(['src/a.ts'], [attempt(d1, ['src/a.ts'], { fastForward: false })], [], NOW, 'win32')['src/a.ts']).toMatchObject({ kind: 'unknown', why: 'not-fast-forward' })
  })

  it('says unknown for uncommitted edits in the project folder, and agent in an Astera worktree', () => {
    const open = dispatch({ id: 'd1', endedAt: undefined, git: { base: 'aaaaaaa' } })
    expect(attributeFiles(['src/a.ts'], [attempt(open, ['src/a.ts'], { shared: true, fastForward: null })], [], NOW, 'win32')['src/a.ts']).toMatchObject({
      kind: 'unknown',
      why: 'shared-folder-live'
    })
    const live = attributeFiles(['src/a.ts'], [attempt(open, ['src/a.ts'], { fastForward: null })], [], NOW, 'win32')['src/a.ts']
    expect(live.kind).toBe('agent')
    expect(live.evidence[0].head).toBeNull()
  })

  it('says unknown, no range, for a file no attempt’s range changed, as a commit made before a late base', () => {
    const d1 = dispatch({ id: 'd1' })
    const unread = dispatch({ id: 'd2', startedAt: '2026-11-27T10:20:00.000Z', endedAt: '2026-11-27T10:30:00.000Z' })
    const got = attributeFiles(['src/first-commit.ts'], [attempt(d1, ['src/a.ts']), attempt(unread, null)], [], NOW, 'win32')
    expect(got['src/first-commit.ts']).toEqual({ kind: 'unknown', why: 'no-range', evidence: [] })
  })

  it('confirms by the observe audit only when every attempt that changed the file was seen writing it', () => {
    const d1 = dispatch({ id: 'd1' })
    const d2 = dispatch({ id: 'd2', startedAt: '2026-11-27T10:20:00.000Z', endedAt: '2026-11-27T10:30:00.000Z' })
    const both = attributeFiles(['src/a.ts'], [attempt(d1, ['src/a.ts'], { audited: new Set(['src/a.ts']) }), attempt(d2, ['src/a.ts'], { audited: new Set(['src/a.ts']) })], [], NOW, 'win32')
    expect(both['src/a.ts'].level).toBe('observe-audit')
    const one = attributeFiles(['src/a.ts'], [attempt(d1, ['src/a.ts'], { audited: new Set(['src/a.ts']) }), attempt(d2, ['src/a.ts'])], [], NOW, 'win32')
    expect(one['src/a.ts'].level).toBe('recorded-range')
  })

  it('leaves review attempts out of the overlap', () => {
    const d1 = dispatch({ id: 'd1' })
    const review = dispatch({ id: 'r1', review: true, startedAt: '2026-11-27T10:05:00.000Z' })
    expect(attributeFiles(['src/a.ts'], [attempt(d1, ['src/a.ts'])], [review], NOW, 'win32')['src/a.ts'].kind).toBe('agent')
  })
})
