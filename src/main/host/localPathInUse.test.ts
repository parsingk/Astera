import { describe, it, expect } from 'vitest'
import { localPathInUse, appPathInUse, type LocalUseEntry, type AppOwnedManagers } from './localPathInUse'
import { foldsCaseHere } from '../../core/testPaths'

const entry = (cwd: string, tag: string): LocalUseEntry => ({ cwd, tag })

describe('localPathInUse', () => {
  it('answers the tag of a local session under the path', () => {
    expect(localPathInUse([entry('D:/r/sub', 'SESSION:worker')], 'D:/r')).toBe('SESSION:worker')
  })

  it('answers the tag of a local one at the path itself', () => {
    expect(localPathInUse([entry('D:/r', 'TERMINAL:abc')], 'D:/r')).toBe('TERMINAL:abc')
  })

  it('does not count a sibling folder that merely shares a prefix', () => {
    expect(localPathInUse([entry('D:/r-sibling', 'SESSION:other')], 'D:/r')).toBeNull()
  })

  // The answer decides whether a folder may be deleted. On linux `/r/PROJ` is another folder than
  // `/r/proj`, so a session there must not keep `/r/proj` from being removed — nor, on win32 and darwin,
  // may a differently cased spelling of the same folder let it be removed under a running session.
  it('counts a session in a differently cased spelling only where the platform folds case', () => {
    expect(localPathInUse([entry('/r/PROJ/x', 'SESSION:s')], '/r/proj')).toBe(foldsCaseHere ? 'SESSION:s' : null)
  })

  it('answers null when nothing is running there at all', () => {
    expect(localPathInUse([], 'D:/r')).toBeNull()
    expect(localPathInUse([entry('D:/other', 'SESSION:x')], 'D:/r')).toBeNull()
  })
})

const managers = (over: Partial<AppOwnedManagers> = {}): AppOwnedManagers => ({
  sessions: { runningAppOwned: () => [] },
  terminal: { runningAppOwned: () => [] },
  run: { runningAppOwned: () => [] },
  chat: { runningAppOwned: () => [] },
  ...over
})

describe('appPathInUse', () => {
  // Fix round 1, I1: a run is a pty too, and was missing from the answer — a local dev server
  // survived only because the Host could not see it, which is exactly what plan risk 3 is against.
  it('answers the tag of a local run under the path', () => {
    const m = managers({ run: { runningAppOwned: () => [{ cwd: 'D:/r/sub', configName: 'dev' }] } })
    expect(appPathInUse(m, 'D:/r')).toBe('RUN:dev')
  })

  it('answers the tag of a local chat session under the path', () => {
    const m = managers({ chat: { runningAppOwned: () => [{ cwd: 'D:/r/sub', title: 'planning' }] } })
    expect(appPathInUse(m, 'D:/r')).toBe('SESSION:planning')
  })

  it('answers the tag of a local terminal session under the path', () => {
    const m = managers({
      sessions: { runningAppOwned: () => [{ cwd: 'D:/r/sub', title: 'worker' }] },
      terminal: { runningAppOwned: () => [{ id: 'abc', projectPath: 'D:/elsewhere' }] }
    })
    expect(appPathInUse(m, 'D:/r')).toBe('SESSION:worker')
  })

  // The wiring itself (fix round 1, I4): removing a manager from the aggregation, or swapping
  // `runningAppOwned` for a method that also returns Host-backed entries, is caught here rather than
  // only in ipc.ts, which is not unit-tested.
  it('aggregates all four managers, and answers null when none of them has anything there', () => {
    const m: AppOwnedManagers = {
      sessions: { runningAppOwned: () => [{ cwd: 'D:/a', title: 's' }] },
      terminal: { runningAppOwned: () => [{ id: 't1', projectPath: 'D:/b' }] },
      run: { runningAppOwned: () => [{ cwd: 'D:/c', configName: 'dev' }] },
      chat: { runningAppOwned: () => [{ cwd: 'D:/d', title: 'chat' }] }
    }
    expect(appPathInUse(m, 'D:/a')).toBe('SESSION:s')
    expect(appPathInUse(m, 'D:/b')).toBe('TERMINAL:t1')
    expect(appPathInUse(m, 'D:/c')).toBe('RUN:dev')
    expect(appPathInUse(m, 'D:/d')).toBe('SESSION:chat')
    expect(appPathInUse(m, 'D:/nowhere')).toBeNull()
  })
})
