import { describe, it, expect } from 'vitest'
import type { PtyFactory, PtyLike, PtySpawnOptions } from '../core/sessions/pty'
import { TerminalManager } from './terminalManager'

class FakePty implements PtyLike {
  pid = 999
  dataCb: (d: string) => void = () => {}
  exitCb: (e: { exitCode: number }) => void = () => {}
  killed = false
  written: string[] = []
  resized: { cols: number; rows: number }[] = []
  onData(cb: (d: string) => void) { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb }
  write(d: string) { this.written.push(d) }
  resize(cols: number, rows: number) { this.resized.push({ cols, rows }) }
  kill() { this.killed = true; this.exitCb({ exitCode: 0 }) }
  pause() {}
  resume() {}
}

function setup(platform: NodeJS.Platform = 'win32') {
  const spawned: { file: string; args: string[] | string; opts: PtySpawnOptions; pty: FakePty }[] = []
  const factory: PtyFactory = (file, args, opts) => {
    const pty = new FakePty()
    spawned.push({ file, args, opts, pty })
    return pty
  }
  const mgr = new TerminalManager(factory, platform, (f) => f === 'pwsh.exe', undefined)
  return { mgr, spawned }
}

describe('TerminalManager', () => {
  it('해석된 셸을 프로젝트 경로 cwd로 spawn한다', () => {
    const { mgr, spawned } = setup()
    const info = mgr.open('D:\\work\\proj')
    expect(info.projectPath).toBe('D:\\work\\proj')
    expect(info.id).toBeTruthy()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('pwsh.exe')
    expect(spawned[0].args).toEqual([])
    expect(spawned[0].opts.cwd).toBe('D:\\work\\proj')
  })

  it('cols/rows를 넘기면 그대로 쓰고, 없으면 기본값', () => {
    const { mgr, spawned } = setup()
    mgr.open('D:\\p', 100, 40)
    expect({ cols: spawned[0].opts.cols, rows: spawned[0].opts.rows }).toEqual({ cols: 100, rows: 40 })
    mgr.open('D:\\p')
    expect({ cols: spawned[1].opts.cols, rows: spawned[1].opts.rows }).toEqual({ cols: 120, rows: 30 })
  })

  it('같은 프로젝트에 여러 개를 열 수 있고 id가 서로 다르다', () => {
    const { mgr } = setup()
    const a = mgr.open('D:\\p')
    const b = mgr.open('D:\\p')
    expect(a.id).not.toBe(b.id)
    expect(mgr.list('D:\\p').map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('list는 프로젝트별로 격리된다', () => {
    const { mgr } = setup()
    const a = mgr.open('D:\\one')
    mgr.open('D:\\two')
    expect(mgr.list('D:\\one').map((t) => t.id)).toEqual([a.id])
    expect(mgr.list('D:\\one')).toHaveLength(1)
    expect(mgr.list('D:\\nope')).toEqual([])
  })

  it('출력을 버퍼에 누적하고 onData로 알린다', () => {
    const { mgr, spawned } = setup()
    const seen: { id: string; data: string }[] = []
    mgr.onData = (e) => seen.push(e)
    const info = mgr.open('D:\\p')
    spawned[0].pty.dataCb('hello ')
    spawned[0].pty.dataCb('world')
    expect(seen).toEqual([
      { id: info.id, data: 'hello ' },
      { id: info.id, data: 'world' }
    ])
    expect(mgr.list('D:\\p')[0].buffer).toBe('hello world')
  })

  it('버퍼는 200,000자에서 잘린다 (뒤쪽을 남긴다)', () => {
    const { mgr, spawned } = setup()
    mgr.open('D:\\p')
    spawned[0].pty.dataCb('x'.repeat(199_998))
    spawned[0].pty.dataCb('abcd')
    const buf = mgr.list('D:\\p')[0].buffer
    expect(buf).toHaveLength(200_000)
    expect(buf.endsWith('abcd')).toBe(true)
  })

  it('write/resize를 해당 pty에만 전달한다', () => {
    const { mgr, spawned } = setup()
    const a = mgr.open('D:\\p')
    mgr.open('D:\\p')
    mgr.write(a.id, 'ls\r')
    mgr.resize(a.id, 90, 20)
    expect(spawned[0].pty.written).toEqual(['ls\r'])
    expect(spawned[0].pty.resized).toEqual([{ cols: 90, rows: 20 }])
    expect(spawned[1].pty.written).toEqual([])
    expect(spawned[1].pty.resized).toEqual([])
  })

  it('없는 id로 write/resize/close해도 던지지 않는다', () => {
    const { mgr } = setup()
    expect(() => {
      mgr.write('nope', 'x')
      mgr.resize('nope', 1, 1)
      mgr.close('nope')
    }).not.toThrow()
  })

  it('close는 pty를 kill하고 목록에서 즉시 제거한다', () => {
    const { mgr, spawned } = setup()
    const info = mgr.open('D:\\p')
    mgr.close(info.id)
    expect(spawned[0].pty.killed).toBe(true)
    expect(mgr.list('D:\\p')).toEqual([])
  })

  it('셸이 스스로 죽으면 목록에서 사라지고 onExit이 발생한다', () => {
    const { mgr, spawned } = setup()
    const exited: { id: string; exitCode: number }[] = []
    mgr.onExit = (e) => exited.push(e)
    const info = mgr.open('D:\\p')
    spawned[0].pty.exitCb({ exitCode: 3 })
    expect(exited).toEqual([{ id: info.id, exitCode: 3 }])
    expect(mgr.list('D:\\p')).toEqual([])
  })

  it('closeAll은 모든 프로젝트의 터미널을 kill한다', () => {
    const { mgr, spawned } = setup()
    mgr.open('D:\\one')
    mgr.open('D:\\two')
    mgr.closeAll()
    expect(spawned.every((s) => s.pty.killed)).toBe(true)
    expect(mgr.list('D:\\one')).toEqual([])
    expect(mgr.list('D:\\two')).toEqual([])
  })

  it('non-win32에서는 envShell을 쓴다', () => {
    const spawned: { file: string }[] = []
    const factory: PtyFactory = (file) => {
      spawned.push({ file })
      return new FakePty()
    }
    const mgr = new TerminalManager(factory, 'linux', () => false, '/bin/zsh')
    mgr.open('/home/u/p')
    expect(spawned[0].file).toBe('/bin/zsh')
  })
})
