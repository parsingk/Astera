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
    // d2's base was recorded after its first commit: that commit is in neither d1's range nor d2's
    const d1 = dispatch({ id: 'd1' })
    const d2 = dispatch({ id: 'd2', startedAt: '2026-11-27T10:20:00.000Z', endedAt: '2026-11-27T10:30:00.000Z', git: { base: 'late111', head: 'ccccccc' } })
    const got = attributeFiles(['src/first-commit.ts', 'src/later.ts'], [attempt(d1, ['src/a.ts']), attempt(d2, ['src/later.ts'])], [], NOW, 'win32')
    expect(got['src/first-commit.ts']).toEqual({ kind: 'unknown', why: 'no-range', evidence: [] })
    expect(got['src/later.ts'].evidence.map((e) => e.dispatchId)).toEqual(['d2'])
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

  // Final review M4: a file no read attempt changed, while some attempt was not read, is not "no recorded range"
  it('says unknown, not read, when an attempt could not be read or older attempts were left out', () => {
    const d1 = dispatch({ id: 'd1' })
    const unread = dispatch({ id: 'd2', startedAt: '2026-11-27T10:20:00.000Z', endedAt: '2026-11-27T10:30:00.000Z' })
    expect(attributeFiles(['src/x.ts'], [attempt(d1, ['src/a.ts']), attempt(unread, null)], [], NOW, 'win32', { someUnread: false })['src/x.ts']).toEqual({ kind: 'unknown', why: 'unread', evidence: [] })
    expect(attributeFiles(['src/x.ts'], [attempt(d1, ['src/a.ts'])], [], NOW, 'win32', { someUnread: true })['src/x.ts']).toEqual({ kind: 'unknown', why: 'unread', evidence: [] })
    expect(attributeFiles(['src/x.ts'], [attempt(d1, ['src/a.ts'])], [], NOW, 'win32')['src/x.ts'].why).toBe('no-range')
  })

  // Final review M14: an ended attempt whose head was never recorded reads its folder as it is: in the project folder,
  // a person's uncommitted edits are in it, so it is unknown too
  it('says unknown for an ended attempt read up to the project folder’s working tree', () => {
    const noHead = dispatch({ id: 'd1', git: { base: 'aaaaaaa' } })
    expect(attributeFiles(['src/a.ts'], [attempt(noHead, ['src/a.ts'], { shared: true, fastForward: null })], [], NOW, 'win32')['src/a.ts']).toMatchObject({ kind: 'unknown', why: 'shared-folder-live' })
  })

  // Final review M3: the overlap rule is asked once per attempt, not once per file and attempt against every Dispatch
  it('attributes 500 files against 5000 Dispatches on record quickly', () => {
    const others = Array.from({ length: 5000 }, (_, i) => dispatch({ id: `o${i}`, taskId: 'other', cwd: `F:\\elsewhere\\${i}`, startedAt: '2026-11-20T10:00:00.000Z', endedAt: '2026-11-20T10:10:00.000Z' }))
    const paths = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts`)
    const attempts = Array.from({ length: 5 }, (_, i) => attempt(dispatch({ id: `d${i}`, startedAt: `2026-11-27T1${i}:00:00.000Z`, endedAt: `2026-11-27T1${i}:30:00.000Z` }), paths))
    const started = Date.now()
    const got = attributeFiles(paths, attempts, others, NOW, 'win32')
    expect(got['src/f0.ts'].kind).toBe('agent')
    expect(Date.now() - started).toBeLessThan(500)
  })
})
