import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// 모듈 싱글턴이라 테스트마다 새로 import해 상태(buffers·listeners·initialized)를 격리한다
// — worktreeBus.test.ts와 같은 관례.
let mod: typeof import('./sessionBus')

type DataEvent = { sessionId: string; data: string }
/** init()이 window.api.on('session:data')로 등록한 핸들러. main이 보내는 이벤트를 흉내내려면
 *  이것을 직접 부른다 — init의 계약(인자 없음·중복 호출 무해)은 바꾸지 않았다. */
let emit: (e: DataEvent) => void = () => {}

beforeEach(async () => {
  emit = () => {}
  // 테스트 환경은 node라 window가 없다. init()이 의존하는 최소한만 세운다.
  vi.stubGlobal('window', {
    api: {
      on: (_channel: string, cb: (e: DataEvent) => void) => {
        emit = cb
        return () => {}
      }
    }
  })
  vi.resetModules()
  mod = await import('./sessionBus')
  mod.init()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const CAP = 256 * 1024
/** 실제 절단 지점 — 상한 도달 후 청크마다 평탄화하지 않으려는 히스테리시스 (sessionBus.ts) */
const TRIM_AT = CAP * 1.5

describe('sessionBus', () => {
  it('리스너가 붙어 있으면 버퍼링하지 않고 바로 전달한다', () => {
    const got: string[] = []
    mod.attach('s1', (d) => got.push(d))
    emit({ sessionId: 's1', data: 'hello' })
    expect(got).toEqual(['hello'])
  })

  it('리스너가 없으면 버퍼에 모아 두고 attach 시 한 번에 준다', () => {
    emit({ sessionId: 's1', data: 'a' })
    emit({ sessionId: 's1', data: 'b' })
    const got: string[] = []
    mod.attach('s1', (d) => got.push(d))
    expect(got).toEqual(['ab'])
  })

  // 상한이 없으면 탭 없는 세션(오케스트레이션 워커)의 출력이 무계로 자란다.
  // 종전에 안전했던 것은 우연이다 — manager.ts의 PTY 영구 정지가 100KB에서 상한 역할을 했고,
  // 이후 그 정지에 자동 해제를 붙여 그 우연한 상한이 사라졌다.
  it('리스너가 없을 때 버퍼는 유계다 — 계속 밀어 넣어도 절단 지점을 넘지 않는다', () => {
    // 2MB를 100KB씩 밀어 넣는다. 상한이 없으면 2MB가 그대로 남는다
    for (let i = 0; i < 20; i++) emit({ sessionId: 's1', data: 'x'.repeat(100 * 1024) })
    let received = ''
    mod.attach('s1', (d) => {
      received = d
    })
    expect(received.length).toBeLessThanOrEqual(TRIM_AT)
    expect(received.length).toBeGreaterThanOrEqual(CAP) // 꼬리는 상한만큼 온전히 남긴다
  })

  it('절단되면 앞이 아니라 뒤가 남는다 (터미널은 최근 출력을 원한다)', () => {
    emit({ sessionId: 's1', data: 'FIRST' + 'x'.repeat(2 * CAP) }) // 절단 지점 초과
    emit({ sessionId: 's1', data: 'LAST' })
    let received = ''
    mod.attach('s1', (d) => {
      received = d
    })
    expect(received.endsWith('LAST')).toBe(true)
    expect(received).not.toContain('FIRST')
    expect(received.length).toBeLessThanOrEqual(TRIM_AT)
  })

  it('상한 이하면 전부 보존된다 — 정상 마운트 창의 회귀 방어', () => {
    // manager.ts의 highWater(100KB)보다 상한이 커야 spawn → TerminalView attach 창에서 잘리지 않는다
    const data = 'y'.repeat(100 * 1024)
    emit({ sessionId: 's1', data })
    let received = ''
    mod.attach('s1', (d) => {
      received = d
    })
    expect(received).toBe(data)
  })

  it('discard는 쌓인 버퍼를 지운다', () => {
    emit({ sessionId: 's1', data: 'a' })
    mod.discard('s1')
    const got: string[] = []
    mod.attach('s1', (d) => got.push(d))
    expect(got).toEqual([])
  })

  it('detach 후에는 전달이 멈추고 이후 출력은 다시 버퍼로 간다', () => {
    const first: string[] = []
    const off = mod.attach('s1', (d) => first.push(d))
    emit({ sessionId: 's1', data: 'a' })
    off()
    emit({ sessionId: 's1', data: 'b' }) // 리스너가 없으니 버퍼로
    const second: string[] = []
    mod.attach('s1', (d) => second.push(d))
    expect(first).toEqual(['a']) // detach 뒤의 'b'는 오지 않았다
    expect(second).toEqual(['b'])
  })
})
