import { describe, it, expect } from 'vitest'
import { localPathInUse, type LocalUseEntry } from './localPathInUse'

const local = (cwd: string, tag: string): LocalUseEntry => ({ cwd, tag, outlivesApp: false })
const hostBacked = (cwd: string, tag: string): LocalUseEntry => ({ cwd, tag, outlivesApp: true })

describe('localPathInUse', () => {
  it('answers the tag of a local session under the path', () => {
    expect(localPathInUse([local('D:/r/sub', 'SESSION:worker')], 'D:/r')).toBe('SESSION:worker')
  })

  it('answers the tag of a local one at the path itself', () => {
    expect(localPathInUse([local('D:/r', 'TERMINAL:abc')], 'D:/r')).toBe('TERMINAL:abc')
  })

  it('does not count a sibling folder that merely shares a prefix', () => {
    expect(localPathInUse([local('D:/r-sibling', 'SESSION:other')], 'D:/r')).toBeNull()
  })

  it('does not count a Host-backed one — the Host already sees it', () => {
    expect(localPathInUse([hostBacked('D:/r/sub', 'SESSION:worker')], 'D:/r')).toBeNull()
  })

  it('answers null when nothing is running there at all', () => {
    expect(localPathInUse([], 'D:/r')).toBeNull()
    expect(localPathInUse([local('D:/other', 'SESSION:x')], 'D:/r')).toBeNull()
  })
})
