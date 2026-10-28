import { describe, it, expect, vi } from 'vitest'
import { freePort, killTree, processStartTimes } from './native'

describe('processStartTimes', () => {
  it('asks once for every pid and reads pid|ms lines', async () => {
    const exec = vi.fn(async () => '100|1700000000000\r\n200|1700000000500\r\nnoise\r\n')
    const r = await processStartTimes([100, 200, 300], exec, 'win32')
    expect([...r.entries()]).toEqual([
      [100, 1700000000000],
      [200, 1700000000500]
    ])
    const [file, args] = exec.mock.calls[0] as unknown as [string, string[]]
    expect(file).toBe('powershell.exe')
    expect(args.at(-1)).toContain('ProcessId=100 OR ProcessId=200 OR ProcessId=300')
  })

  it('asks nothing for no pids, and refuses a pid that is not a positive integer', async () => {
    const exec = vi.fn(async () => '')
    expect((await processStartTimes([], exec, 'win32')).size).toBe(0)
    expect(exec).not.toHaveBeenCalled()
    await expect(processStartTimes([1.5], exec, 'win32')).rejects.toThrow('not a pid')
  })

  it('on macOS reads ps lstart, and never runs PowerShell', async () => {
    const exec = vi.fn(async () => '  100 Sat Sep 27 10:11:12 2026\n')
    const r = await processStartTimes([100, 200], exec, 'darwin')
    expect([...r.entries()]).toEqual([[100, new Date(2026, 8, 27, 10, 11, 12).getTime()]])
    expect(exec).toHaveBeenCalledWith('env', ['LC_ALL=C', 'ps', '-o', 'pid=,lstart=', '-p', '100,200'])
  })
})

describe('killTree', () => {
  it('ends the tree with taskkill', async () => {
    const exec = vi.fn(async () => '')
    await killTree(321, exec, 'win32')
    expect(exec).toHaveBeenCalledWith('taskkill', ['/pid', '321', '/T', '/F'])
  })

  it('a process that is already gone is not a failure', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { code: 128 })
    })
    await expect(killTree(321, exec, 'win32')).resolves.toBeUndefined()
  })

  it('off Windows ends the tree from one ps listing, the group of a child started detached included, never through taskkill (R10)', async () => {
    // 321 leads its group; 322 is its child in a session of its own (a detached spawn calls setsid).
    const exec = vi.fn(async () => '  321     1   321\n  322   321   322\n')
    const sent: Array<[number, NodeJS.Signals | 0]> = []
    const signals = {
      kill: (pid: number, sig: NodeJS.Signals | 0) => {
        sent.push([pid, sig])
        if (sig === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      },
      sleep: async () => {}
    }
    await killTree(321, exec, 'linux', signals)
    expect(exec.mock.calls).toEqual([['env', ['LC_ALL=C', 'ps', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=']]])
    expect(sent).toEqual([[-321, 'SIGTERM'], [-322, 'SIGTERM'], [-321, 0], [-322, 0]])
  })
})

describe('freePort', () => {
  it('answers a loopback port nobody holds', async () => {
    const p = await freePort()
    expect(Number.isSafeInteger(p) && p > 0 && p < 65536).toBe(true)
  })
})
