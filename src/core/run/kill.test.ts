import { describe, it, expect } from 'vitest'
import { killProcessTree, treeKillCommand } from './kill'

describe('treeKillCommand', () => {
  it('win32는 taskkill로 프로세스 트리를 강제 종료한다', () => {
    expect(treeKillCommand('win32', 1234)).toEqual({ file: 'taskkill', args: ['/pid', '1234', '/T', '/F'] })
  })
  it('posix는 null (호출자가 pty.kill로 프로세스그룹 종료)', () => {
    expect(treeKillCommand('linux', 1234)).toBeNull()
    expect(treeKillCommand('darwin', 1234)).toBeNull()
  })
})

// Audit U-4: a How It Works agent or a model listing that ran past its time was killed with child.kill(), which on
// win32 ends the cmd.exe wrapper around an npm shim and leaves claude or codex running, spending tokens.
describe('killProcessTree', () => {
  it('on win32 asks taskkill for the whole tree, and kills the child too', () => {
    const ran: Array<{ file: string; args: string[] }> = []
    let killed = 0
    killProcessTree({ pid: 4242, kill: () => ((killed++), true) }, { platform: 'win32', exec: (file, args) => void ran.push({ file, args }) })
    expect(ran).toEqual([{ file: 'taskkill', args: ['/pid', '4242', '/T', '/F'] }])
    expect(killed).toBe(1)
  })
  it('elsewhere kills the child alone, and never throws', () => {
    let killed = 0
    killProcessTree({ pid: 1, kill: () => ((killed++), true) }, { platform: 'linux', exec: () => { throw new Error('no') } })
    expect(killed).toBe(1)
    expect(() => killProcessTree({ pid: undefined, kill: () => { throw new Error('gone') } }, { platform: 'win32' })).not.toThrow()
  })
})
