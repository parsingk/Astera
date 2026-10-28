import { describe, it, expect } from 'vitest'
import type { LinuxDeskDeps } from './deskLinux'
import type { MacDeskDeps } from './deskMac'
import { workspaceDeskStarter } from './platformDesk'
import type { SpawnedProc } from './posixProc'

const proc = (pid: number, ready = ''): SpawnedProc => ({ pid, onExit: () => {}, stderrTail: () => '', readyText: () => ready, kill: () => {} })

describe('workspaceDeskStarter', () => {
  it('on Linux starts an Xvfb through the Linux desks', async () => {
    const spawned: string[] = []
    const linux: LinuxDeskDeps = {
      hostEnv: {},
      // Xvfb reports its display number on the -displayfd pipe, which is how the Linux desk knows it is up.
      spawn: (file, args) => {
        spawned.push(file)
        return proc(77, args[0].slice(1) + '\n')
      },
      run: async () => Buffer.alloc(0),
      exists: async () => false,
      makeRuntimeDir: async () => '/tmp/astera-xrt-1',
      removeDir: async () => {},
      writeFile: async () => {},
      startTime: async () => 5,
      killTree: async () => {},
      sleep: async () => {},
      now: () => 0,
      log: () => {}
    }
    const desk = await workspaceDeskStarter({ platform: 'linux', profileDir: '/unused', hostEnv: {}, log: () => {}, linux })('astera-ws-1-1')
    expect(spawned).toEqual(['Xvfb'])
    expect(desk).toMatchObject({ name: 'astera-ws-1-1', pid: 77, startedAt: 5 })
  })

  it('on macOS gives a background desk with no helper process', async () => {
    const mac: MacDeskDeps = {
      spawn: () => proc(1),
      exec: async () => '',
      startTime: async () => null,
      killTree: async () => {},
      sleep: async () => {},
      now: () => 0,
      log: () => {}
    }
    const desk = await workspaceDeskStarter({ platform: 'darwin', profileDir: '/unused', hostEnv: {}, log: () => {}, mac })('astera-ws-1-1')
    expect(desk).toMatchObject({ name: 'mac-bg-astera-ws-1-1', pid: null })
  })

  it('on any other platform rejects with the unsupported reason and starts nothing', async () => {
    const start = workspaceDeskStarter({ platform: 'freebsd', profileDir: '/unused', hostEnv: {}, log: () => {} })
    await expect(start('astera-ws-1-1')).rejects.toThrow('does not run on freebsd')
  })
})
