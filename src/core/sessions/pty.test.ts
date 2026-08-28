import { describe, it, expect } from 'vitest'
import { withExitedPtyGuard, type PtyLike } from './pty'

/** node-pty 의 **두 단계 종료 통지**를 그대로 흉내낸다.
 *
 *  nativeExit() — 네이티브가 프로세스 종료를 알린 순간. 이때 windowsPtyAgent 의 _exitCode 가 서고,
 *                 그 뒤의 resize 는 'Cannot resize a pty that has already exited' 를 동기로 던진다.
 *                 **onExit 은 아직 오지 않았다.**
 *  emitExit()   — 출력 소켓이 닫히며 뒤늦게 도착하는 JS onExit.
 *
 *  다른 테스트 파일들의 FakePty 는 이 둘을 한 번에 처리해서(exited 플래그와 exitCb 를 같이) 그
 *  사이 구간이 아예 재현되지 않았다 — 그래서 테스트는 통과하는데 앱은 죽었다. */
class TwoPhasePty implements PtyLike {
  pid = 4242
  dataCb: (d: string) => void = () => {}
  exitCb: (e: { exitCode: number }) => void = () => {}
  killed = false
  paused = 0
  resumed = 0
  written: string[] = []
  resized: { cols: number; rows: number }[] = []
  private dead = false

  onData(cb: (d: string) => void): void { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb }
  write(d: string): void {
    if (this.dead) throw new Error('Cannot write to a pty that has already exited')
    this.written.push(d)
  }
  resize(cols: number, rows: number): void {
    if (this.dead) throw new Error('Cannot resize a pty that has already exited')
    this.resized.push({ cols, rows })
  }
  kill(): void { this.killed = true }
  pause(): void { this.paused++ }
  resume(): void { this.resumed++ }

  nativeExit(): void { this.dead = true }
  emitExit(exitCode: number): void { this.exitCb({ exitCode }) }
}

describe('withExitedPtyGuard', () => {
  // 이 구간이 이 가드의 존재 이유다. 실행 패널이 열리는 순간 ResizeObserver 가 보내는 resize 가
  // 빠르게 끝나는 실행의 종료와 겹치면, 던져진 예외가 ipcMain 핸들러 밖으로 나가 main 프로세스가
  // 통째로 죽었다. 호출자들의 종료 가드는 전부 늦은 쪽 신호(onExit)를 보므로 여기를 막지 못한다.
  it('onExit 이 오기 전 구간의 resize 를 던지지 않고 삼킨다', () => {
    const raw = new TwoPhasePty()
    const p = withExitedPtyGuard(raw)
    raw.nativeExit()
    expect(() => p.resize(120, 30)).not.toThrow()
    expect(raw.resized).toEqual([])
  })

  it('같은 구간의 write 도 던지지 않는다', () => {
    const raw = new TwoPhasePty()
    const p = withExitedPtyGuard(raw)
    raw.nativeExit()
    expect(() => p.write('x')).not.toThrow()
    expect(raw.written).toEqual([])
  })

  // 가드가 정상 경로까지 막으면 터미널 입력과 크기 조정이 조용히 죽는다
  it('살아 있는 동안에는 그대로 전달한다', () => {
    const raw = new TwoPhasePty()
    const p = withExitedPtyGuard(raw)
    p.write('hello')
    p.resize(100, 40)
    expect(raw.written).toEqual(['hello'])
    expect(raw.resized).toEqual([{ cols: 100, rows: 40 }])
  })

  // 나머지 표면은 그대로 이어져야 한다 — 호출자는 이 래퍼가 끼어든 것을 알지 못한다
  it('pid·onData·onExit·kill·pause·resume 을 그대로 잇는다', () => {
    const raw = new TwoPhasePty()
    const p = withExitedPtyGuard(raw)
    const seen: string[] = []
    const exits: number[] = []
    p.onData((d) => seen.push(d))
    p.onExit((e) => exits.push(e.exitCode))
    raw.dataCb('out')
    raw.nativeExit()
    raw.emitExit(7)
    p.kill()
    p.pause()
    p.resume()
    expect(p.pid).toBe(4242)
    expect(seen).toEqual(['out'])
    expect(exits).toEqual([7])
    expect(raw.killed).toBe(true)
    expect(raw.paused).toBe(1)
    expect(raw.resumed).toBe(1)
  })
})
