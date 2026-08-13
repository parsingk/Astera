import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { pinCursorBlinkOff } from './cursorBlink'

type CsiId = { prefix?: string; intermediates?: string; final: string }
type CsiHandler = (params: (number | number[])[]) => boolean | Promise<boolean>

/** pinCursorBlinkOff가 쓰는 xterm API만 흉내내는 최소 스텁 (실 Terminal은 DOM이 필요해 쓸 수 없다) */
function fakeTerm(): {
  term: Terminal
  csi: { id: CsiId; cb: CsiHandler }[]
  parsed: (() => void)[]
  turnBlinkOn: () => void
  readonly blink: boolean
  readonly optionWrites: number
} {
  const csi: { id: CsiId; cb: CsiHandler }[] = []
  const parsed: (() => void)[] = []
  let blink = false
  let optionWrites = 0
  const stub = {
    options: {
      get cursorBlink(): boolean {
        return blink
      },
      set cursorBlink(v: boolean) {
        blink = v
        optionWrites++
      }
    },
    parser: {
      registerCsiHandler: (id: CsiId, cb: CsiHandler) => {
        const entry = { id, cb }
        csi.push(entry)
        return {
          dispose: () => {
            csi.splice(csi.indexOf(entry), 1)
          }
        }
      }
    },
    onWriteParsed: (cb: () => void) => {
      parsed.push(cb)
      return {
        dispose: () => {
          parsed.splice(parsed.indexOf(cb), 1)
        }
      }
    }
  }
  return {
    term: stub as unknown as Terminal,
    csi,
    parsed,
    turnBlinkOn: () => {
      blink = true // DECSET 12(CSI ?12h)가 옵션을 켠 상황
    },
    get blink() {
      return blink
    },
    get optionWrites() {
      return optionWrites
    }
  }
}

describe('pinCursorBlinkOff', () => {
  it('DECSCUSR(CSI Ps SP q)을 가로채 xterm 기본 처리를 막는다', () => {
    const f = fakeTerm()
    pinCursorBlinkOff(f.term)
    expect(f.csi).toHaveLength(1)
    expect(f.csi[0].id).toEqual({ intermediates: ' ', final: 'q' })
    expect(f.csi[0].cb([5])).toBe(true) // 5 = blinking bar
  })

  it('PTY가 옵션을 켜면(DECSET 12) 파싱 후 되돌린다', () => {
    const f = fakeTerm()
    pinCursorBlinkOff(f.term)
    f.turnBlinkOn()
    f.parsed.forEach((cb) => cb())
    expect(f.blink).toBe(false)
  })

  it('점멸이 꺼져 있으면 옵션에 손대지 않는다 — 불필요한 변경 이벤트 방지', () => {
    const f = fakeTerm()
    pinCursorBlinkOff(f.term)
    f.parsed.forEach((cb) => cb())
    expect(f.optionWrites).toBe(0)
  })

  it('dispose하면 핸들러·리스너를 모두 해제한다', () => {
    const f = fakeTerm()
    pinCursorBlinkOff(f.term).dispose()
    expect(f.csi).toHaveLength(0)
    expect(f.parsed).toHaveLength(0)
  })
})
