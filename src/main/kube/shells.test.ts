import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shellArgs } from '../../core/kube/cluster/shell'
import type { ShellMessage, ShellSpec } from '../../core/kube/cluster/types'
import type { PtyFactory, PtyLike, PtySpawnOptions } from '../../core/sessions/pty'
import { createShellRegistry, SHELL_FLUSH_MS } from './shells'

interface FakePty extends PtyLike {
  fireData(d: string): void
  fireExit(code: number): void
  writes: string[]
  resizes: Array<[number, number]>
  kills: number
}

function fakePty(): FakePty {
  let data: (d: string) => void = () => {}
  let exit: (e: { exitCode: number }) => void = () => {}
  const p: FakePty = {
    pid: 1,
    writes: [],
    resizes: [],
    kills: 0,
    onData: (cb) => { data = cb },
    onExit: (cb) => { exit = cb },
    write: (d) => { p.writes.push(d) },
    resize: (c, r) => { p.resizes.push([c, r]) },
    kill: () => { p.kills++ },
    pause: () => {},
    resume: () => {},
    fireData: (d) => data(d),
    fireExit: (code) => exit({ exitCode: code })
  }
  return p
}

const spec: ShellSpec = { ref: { context: 'ctx', namespace: 'ns', kind: 'Pod', name: 'web' } as ShellSpec['ref'], container: 'app' }

function setup(throws?: Error) {
  const ptys: FakePty[] = []
  const calls: Array<{ file: string; args: string[] | string; opts: PtySpawnOptions }> = []
  const sent: ShellMessage[] = []
  const redact = vi.fn((t: string) => `redacted:${t}`)
  const spawn: PtyFactory = (file, args, opts) => {
    calls.push({ file, args, opts })
    if (throws) throw throws
    const p = fakePty()
    ptys.push(p)
    return p
  }
  const reg = createShellRegistry({
    spawn,
    bin: () => 'kubectl.exe',
    env: () => ({ A: '1' }),
    cwd: '/home/me',
    redact,
    emit: (m) => sent.push(m)
  })
  return { reg, ptys, calls, sent, redact }
}

describe('createShellRegistry', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('spawns kubectl with the exec arguments in the home folder', () => {
    const { reg, calls } = setup()
    reg.start('s1', spec, 100, 30)
    expect(calls).toEqual([
      { file: 'kubectl.exe', args: shellArgs(spec.ref, 'app'), opts: { cwd: '/home/me', cols: 100, rows: 30, env: { A: '1' } } }
    ])
    expect(reg.size()).toBe(1)
  })

  it('batches output and sends the exit after the last of it', () => {
    const { reg, ptys, sent } = setup()
    reg.start('s1', spec, 80, 24)
    ptys[0].fireData('a')
    ptys[0].fireData('b')
    expect(sent).toEqual([])
    vi.advanceTimersByTime(SHELL_FLUSH_MS)
    expect(sent).toEqual([{ shellId: 's1', kind: 'data', data: 'ab' }])
    ptys[0].fireData('c')
    ptys[0].fireExit(0)
    expect(sent.slice(1)).toEqual([
      { shellId: 's1', kind: 'data', data: 'c' },
      { shellId: 's1', kind: 'exit', code: 0 }
    ])
    expect(reg.size()).toBe(0)
  })

  it('forwards input and size to the live shell only', () => {
    const { reg, ptys } = setup()
    reg.write('nope', 'x')
    reg.resize('nope', 1, 1)
    reg.start('s1', spec, 80, 24)
    reg.write('s1', 'ls\r')
    reg.resize('s1', 120, 40)
    expect(ptys[0].writes).toEqual(['ls\r'])
    expect(ptys[0].resizes).toEqual([[120, 40]])
    ptys[0].fireExit(1)
    reg.write('s1', 'y')
    reg.resize('s1', 5, 5)
    expect(ptys[0].writes).toEqual(['ls\r'])
    expect(ptys[0].resizes).toEqual([[120, 40]])
  })

  it('stops a shell without reporting its exit', () => {
    const { reg, ptys, sent } = setup()
    reg.start('s1', spec, 80, 24)
    reg.stop('s1')
    expect(ptys[0].kills).toBe(1)
    expect(reg.size()).toBe(0)
    ptys[0].fireData('late')
    ptys[0].fireExit(137)
    vi.advanceTimersByTime(SHELL_FLUSH_MS * 2)
    expect(sent).toEqual([])
    reg.stop('s1')
    expect(ptys[0].kills).toBe(1)
  })

  it('replaces a shell started again under the same id', () => {
    const { reg, ptys, sent } = setup()
    reg.start('s1', spec, 80, 24)
    reg.start('s1', spec, 80, 24)
    expect(ptys[0].kills).toBe(1)
    expect(ptys[1].kills).toBe(0)
    expect(reg.size()).toBe(1)
    ptys[0].fireData('old')
    ptys[0].fireExit(0)
    expect(sent).toEqual([])
    expect(reg.size()).toBe(1)
    ptys[1].fireData('new')
    vi.advanceTimersByTime(SHELL_FLUSH_MS)
    expect(sent).toEqual([{ shellId: 's1', kind: 'data', data: 'new' }])
  })

  it('reports a kubectl that cannot start', () => {
    const { reg, sent, redact } = setup(new Error('File not found: kubectl.exe'))
    reg.start('s1', spec, 80, 24)
    expect(redact).toHaveBeenCalledWith('File not found: kubectl.exe')
    expect(sent).toEqual([{ shellId: 's1', kind: 'error', message: 'redacted:File not found: kubectl.exe' }])
    expect(reg.size()).toBe(0)
  })

  it('stops every shell', () => {
    const { reg, ptys, sent } = setup()
    reg.start('a', spec, 80, 24)
    reg.start('b', spec, 80, 24)
    reg.stopAll()
    expect(ptys.map((p) => p.kills)).toEqual([1, 1])
    expect(reg.size()).toBe(0)
    ptys[0].fireExit(0)
    ptys[1].fireData('x')
    vi.advanceTimersByTime(SHELL_FLUSH_MS * 2)
    expect(sent).toEqual([])
  })
})
