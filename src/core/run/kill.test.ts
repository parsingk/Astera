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
// Final review I-1, I-2: taskkill /T walks the tree from a live parent, so the parent is killed only after it ran
// (as endChild does); and a child already gone is left alone, its id possibly another process's by now.
describe('killProcessTree', () => {
  const child = () => {
    const c = { pid: 4242, exitCode: null as number | null, signalCode: null as string | null, kills: 0, kill: () => ((c.kills++), true) }
    return c
  }
  it('on win32 runs taskkill on the tree first, and kills the parent only once it answered', () => {
    const c = child()
    const ran: Array<{ file: string; args: string[]; done: () => void }> = []
    killProcessTree(c, { platform: 'win32', exec: (file, args, done) => void ran.push({ file, args, done }) })
    expect(ran.map((r) => [r.file, r.args])).toEqual([['taskkill', ['/pid', '4242', '/T', '/F']]])
    expect(c.kills).toBe(0)
    ran[0].done()
    expect(c.kills).toBe(1)
  })
  it('kills nothing for a child that already exited', () => {
    const c = { ...child(), exitCode: 0 }
    const ran: string[] = []
    killProcessTree(c, { platform: 'win32', exec: (file) => void ran.push(file) })
    expect(ran).toEqual([])
    expect(c.kills).toBe(0)
  })
  it('elsewhere kills the child alone, and never throws', () => {
    const c = child()
    killProcessTree(c, { platform: 'linux', exec: () => { throw new Error('no') } })
    expect(c.kills).toBe(1)
    expect(() => killProcessTree({ pid: undefined, exitCode: null, signalCode: null, kill: () => { throw new Error('gone') } }, { platform: 'win32' })).not.toThrow()
  })
})
