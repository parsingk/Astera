import { describe, it, expect } from 'vitest'
import { treeKillCommand } from './kill'

describe('treeKillCommand', () => {
  it('win32는 taskkill로 프로세스 트리를 강제 종료한다', () => {
    expect(treeKillCommand('win32', 1234)).toEqual({ file: 'taskkill', args: ['/pid', '1234', '/T', '/F'] })
  })
  it('posix는 null (호출자가 pty.kill로 프로세스그룹 종료)', () => {
    expect(treeKillCommand('linux', 1234)).toBeNull()
    expect(treeKillCommand('darwin', 1234)).toBeNull()
  })
})
